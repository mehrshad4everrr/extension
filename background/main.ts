import { browser } from "webextension-polyfill-ts"
import { alias, wrapStore } from "webext-redux"
import { configureStore, isPlain } from "@reduxjs/toolkit"
import devToolsEnhancer from "remote-redux-devtools"

import { ETHEREUM } from "./constants/networks"
import { jsonEncodeBigInt, jsonDecodeBigInt } from "./lib/utils"

import {
  startService as startPreferences,
  PreferenceService,
} from "./services/preferences"
import {
  startService as startIndexing,
  IndexingService,
} from "./services/indexing"
import { startService as startChain, ChainService } from "./services/chain"
import {
  startService as startKeyring,
  KeyringService,
} from "./services/keyring"

import { KeyringTypes } from "./types"

import rootReducer from "./redux-slices"
import {
  loadAccount,
  transactionConfirmed,
  transactionSeen,
  updateAccountBalance,
  emitter as accountSliceEmitter,
} from "./redux-slices/accounts"
import { assetsLoaded } from "./redux-slices/assets"
import {
  emitter as keyringSliceEmitter,
  updateKeyrings,
  importLegacyKeyring,
} from "./redux-slices/keyrings"
import { allAliases } from "./redux-slices/utils"

const reduxSanitizer = (input: unknown) => {
  if (typeof input === "bigint") {
    return input.toString()
  }

  // We can use JSON stringify replacer function instead of recursively looping through the input
  if (typeof input === "object") {
    return JSON.parse(jsonEncodeBigInt(input))
  }

  // We only need to sanitize bigints and the objects that contain them
  return input
}

const reduxCache = (store) => (next) => (action) => {
  const result = next(action)
  const state = store.getState()

  if (process.env.REDUX_CACHE === "true") {
    // Browser extension storage supports JSON natively, despite that we have to stringify to preserve BigInts
    browser.storage.local.set({ state: jsonEncodeBigInt(state) })
  }

  return result
}

// Declared out here so ReduxStoreType can be used in Main.store type
// declaration.
const initializeStore = (startupState = {}) =>
  configureStore({
    preloadedState: startupState,
    reducer: rootReducer,
    middleware: (getDefaultMiddleware) => {
      const middleware = getDefaultMiddleware({
        serializableCheck: {
          isSerializable: (value: unknown) =>
            isPlain(value) || typeof value === "bigint",
        },
      })

      // It might be tempting to use an array with `...` destructuring, but
      // unfortunately this fails to preserve important type information from
      // `getDefaultMiddleware`. `push` and `pull` preserve the type
      // information in `getDefaultMiddleware`, including adjustments to the
      // dispatch function type, but as a tradeoff nothing added this way can
      // further modify the type signature. For now, that's fine, as these
      // middlewares don't change acceptable dispatch types.
      //
      // Process aliases before all other middleware, and cache the redux store
      // after all middleware gets a chance to run.
      middleware.unshift(alias(allAliases))
      middleware.push(reduxCache)

      return middleware
    },
    devTools: false,
    enhancers: [
      devToolsEnhancer({
        hostname: "localhost",
        port: 8000,
        realtime: true,
        actionSanitizer: (action: unknown) => {
          return reduxSanitizer(action)
        },

        stateSanitizer: (state: unknown) => {
          return reduxSanitizer(state)
        },
      }),
    ],
  })

type ReduxStoreType = ReturnType<typeof initializeStore>

export default class Main {
  /*
   * A promise to the preference service, a dependency for most other services.
   * The promise will be resolved when the service is initialized.
   */
  preferenceService: Promise<PreferenceService>

  /*
   * A promise to the chain service, keeping track of base asset balances,
   * transactions, and network status. The promise will be resolved when the
   * service is initialized.
   */
  chainService: Promise<ChainService>

  /*
   * A promise to the indexing service, keeping track of token balances and
   * prices. The promise will be resolved when the service is initialized.
   */
  indexingService: Promise<IndexingService>

  /*
   * A promise to the keyring service, which stores key material, derives
   * accounts, and signs messagees and transactions. The promise will be
   * resolved when the service is initialized.
   */
  keyringService: Promise<KeyringService>

  /**
   * The redux store for the wallet core. Note that the redux store is used to
   * render the UI (via webext-redux), but it is _not_ the source of truth.
   * Services interact with the various external and internal components and
   * create persisted state, and the redux store is simply a view onto those
   * pieces of canonical state.
   */
  store: ReduxStoreType

  constructor() {
    // start all services
    this.initializeServices()

    // Setting REDUX_CACHE to false will start the extension with an empty initial state, which can be useful for development
    if (process.env.REDUX_CACHE === "true") {
      browser.storage.local.get("state").then((saved) => {
        this.initializeRedux(jsonDecodeBigInt(saved.state))
      })
    } else {
      this.initializeRedux()
    }
  }

  initializeServices(): void {
    this.preferenceService = startPreferences()
    this.chainService = startChain(this.preferenceService)
    this.indexingService = startIndexing(
      this.preferenceService,
      this.chainService
    ).then(async (service) => {
      const chain = await this.chainService
      await chain.addAccountToTrack({
        // TODO uses Ethermine address for development - move this to startup
        // state
        account: "0xea674fdde714fd979de3edf0f56aa9716b898ec8",
        network: ETHEREUM,
      })
      return service
    })
    this.keyringService = startKeyring()
  }

  async initializeRedux(startupState?): Promise<void> {
    // Start up the redux store and set it up for proxying.
    this.store = initializeStore(startupState)
    wrapStore(this.store, {
      serializer: (payload: unknown) => {
        return jsonEncodeBigInt(payload)
      },
      deserializer: (payload: string) => {
        return jsonDecodeBigInt(payload)
      },
    })

    this.connectIndexingService()
    this.connectKeyringService()
    await this.connectChainService()
  }

  async connectChainService(): Promise<void> {
    const chain = await this.chainService

    // Wire up chain service to account slice.
    chain.emitter.on("accountBalance", (accountWithBalance) => {
      // The first account balance update will transition the account to loading.
      this.store.dispatch(updateAccountBalance(accountWithBalance))
    })
    chain.emitter.on("transaction", (transaction) => {
      if (transaction.blockHash) {
        this.store.dispatch(transactionConfirmed(transaction))
      } else {
        this.store.dispatch(transactionSeen(transaction))
      }
    })

    accountSliceEmitter.on("addAccount", async (accountNetwork) => {
      await chain.addAccountToTrack(accountNetwork)
    })

    // Set up initial state.
    const existingAccounts = await chain.getAccountsToTrack()
    existingAccounts.forEach((accountNetwork) => {
      // Mark as loading and wire things up.
      this.store.dispatch(loadAccount(accountNetwork.account))

      // Force a refresh of the account balance to populate the store.
      chain.getLatestBaseAccountBalance(accountNetwork)
    })
  }

  async connectIndexingService(): Promise<void> {
    const indexing = await this.indexingService

    indexing.emitter.on("accountBalance", (accountWithBalance) => {
      this.store.dispatch(updateAccountBalance(accountWithBalance))
    })

    indexing.emitter.on("assets", (assets) => {
      this.store.dispatch(assetsLoaded(assets))
    })
  }

  async connectKeyringService(): Promise<void> {
    const keyring = await this.keyringService

    keyring.emitter.on("keyrings", (keyrings) => {
      this.store.dispatch(updateKeyrings(keyrings))
    })

    keyringSliceEmitter.on("generateNewKeyring", async () => {
      // TODO move unlocking to a reasonable place in the initialization flow
      await keyring.generateNewKeyring(
        KeyringTypes.mnemonicBIP39S256,
        "password"
      )
    })

    keyringSliceEmitter.on("importLegacyKeyring", async ({ mnemonic }) => {
      await keyring.importLegacyKeyring(mnemonic, "password")
    })

    this.store.dispatch(
      importLegacyKeyring({
        mnemonic:
          // Don't use this to store realy money :)
          "brain surround have swap horror body response double fire dumb bring hazard",
      })
    )
  }
}