'use strict'

const fs = require('fs')
const cc = require('five-bells-condition')
const Config = require('five-bells-shared').Config
const Utils = require('../lib/utils')
const _ = require('lodash')

const envPrefix = 'CONNECTOR'

const DEFAULT_MIN_MESSAGE_WINDOW = 1 // seconds
const DEFAULT_MAX_HOLD_TIME = 10 // seconds
const DEFAULT_FX_SPREAD = 0.002 // 0.2%
const DEFAULT_SLIPPAGE = 0.001 // 0.1%

const DEFAULT_ROUTE_BROADCAST_INTERVAL = 30 * 1000 // milliseconds
const DEFAULT_ROUTE_CLEANUP_INTERVAL = 1000 // milliseconds
const DEFAULT_ROUTE_EXPIRY = 45 * 1000 // milliseconds

function isRunningTests () {
  return (
    process.env.NODE_ENV === 'unit' ||
    process.argv[0].endsWith('mocha') ||
    (process.argv.length > 1 && process.argv[0].endsWith('node') &&
     process.argv[1].endsWith('mocha'))
   )
}

function useTestConfig () {
  return !Config.castBool(process.env.UNIT_TEST_OVERRIDE) && isRunningTests()
}

function generateDefaultPairs (ledgers) {
  return Utils.getPairs(ledgers).map((pair) => {
    return pair.map((desc) => desc.currency + '@' + desc.ledger)
  })
}

function parseCredentialsEnv () {
  return JSON.parse(Config.getEnv(envPrefix, 'CREDENTIALS') || '{}')
}

function parseCredentials () {
  const credentialsEnv = parseCredentialsEnv()

  return _.mapValues(credentialsEnv, (credentials) => {
    const isClientCertCredential = credentials.key !== undefined

    if (isClientCertCredential) {
      return _.omitBy(_.assign(credentials, {
        key: fs.readFileSync(credentials.key),
        cert: fs.readFileSync(credentials.cert),
        ca: credentials.ca && fs.readFileSync(credentials.ca)
      }), _.isUndefined)
    }

    return _.omitBy(_.assign(credentials, {
      ca: credentials.ca && fs.readFileSync(credentials.ca)
    }), _.isUndefined)
  })
}

function parseAdminEnv () {
  const adminUser = Config.getEnv(envPrefix, 'ADMIN_USER') || 'admin'
  const adminPass = Config.getEnv(envPrefix, 'ADMIN_PASS')
  const adminKey = Config.getEnv(envPrefix, 'ADMIN_KEY')
  const adminCert = Config.getEnv(envPrefix, 'ADMIN_CERT')
  const adminCa = Config.getEnv(envPrefix, 'ADMIN_CA')

  return {
    username: adminUser,
    password: adminPass,
    key: adminKey,
    cert: adminCert,
    ca: adminCa
  }
}

function parseLedgers () {
  // List of ledgers this connector has accounts on (used to auto-generate pairs)
  // e.g. ["USD@http://usd-ledger.example","EUR@http://eur-ledger.example/some/path"]
  return JSON.parse(Config.getEnv(envPrefix, 'LEDGERS') || '[]').map((ledger) => {
    const sep = ledger.indexOf('@')
    return { currency: ledger.substr(0, sep), ledger: ledger.substr(sep + 1) }
  })
}

function parseNotificationSignEnv () {
  // On by default in prod
  const isProduction = process.env.NODE_ENV === 'production'
  const mustVerify = Config.castBool(Config.getEnv(envPrefix, 'NOTIFICATION_VERIFY'), isProduction)

  let keys
  try {
    keys = JSON.parse(Config.getEnv(envPrefix, 'NOTIFICATION_KEYS') || '{}')
  } catch (e) {
    throw new Error('Failed to parse CONNECTOR_NOTIFICATION_KEYS')
  }

  return {
    must_verify: mustVerify,
    keys
  }
}

function validateCredentialsEnv () {
  const credentials = parseCredentialsEnv()

  _.forEach(credentials, (credential, ledger) => {
    if ((credential.key === undefined) && (credential.password === undefined)) {
      throw new Error(`Missing key or password for ledger: ${ledger}`)
    } else if (credential.username === undefined) {
      throw new Error(`Missing username for ledger: ${ledger}`)
    } else if ((credential.cert === undefined) !== (credential.key === undefined)) {
      throw new Error(`Missing certificate or key for ledger: ${ledger}`)
    } else if (credential.account_uri === undefined) {
      throw new Error(`Missing account_uri for ledger: ${ledger}`)
    }

    try {
      credential.cert && fs.accessSync(credential.cert, fs.R_OK)
      credential.key && fs.accessSync(credential.key, fs.R_OK)
      credential.ca && fs.accessSync(credential.ca, fs.R_OK)
    } catch (e) {
      throw new Error(`Failed to read credentials for ledger ${ledger}: ${e.message}`)
    }
  })
}

function validateAdminEnv () {
  const admin = parseAdminEnv()

  if ((admin.cert === undefined) !== (admin.key === undefined)) {
    throw new Error('Missing ADMIN_CERT or ADMIN_KEY')
  }

  try {
    admin.cert && fs.accessSync(admin.cert, fs.R_OK)
    admin.key && fs.accessSync(admin.key, fs.R_OK)
    admin.ca && fs.accessSync(admin.ca, fs.R_OK)
  } catch (e) {
    throw new Error(`Failed to read admin credentials: ${e.message}`)
  }
}

function validateNotificationEnv () {
  // Validate notification signing public keys
  const notifications = parseNotificationSignEnv()

  if (notifications.must_verify) {
    const ledgers = parseLedgers()
    for (let ledgerObj of ledgers) {
      const uri = ledgerObj.ledger
      if (notifications.keys[uri] === undefined) {
        throw new Error(`Missing notification signing keys for ledger: ${uri}`)
      }

      try {
        cc.validateCondition(notifications.keys[uri])
      } catch (e) {
        throw new Error(`Failed to read signing key for ledger ${uri}: ${e.message}`)
      }
    }
  }
}

function validateLocalEnvConfig () {
  validateNotificationEnv()
  validateCredentialsEnv()
  validateAdminEnv()
}

function getLocalConfig () {
  validateLocalEnvConfig()

  const ledgers = parseLedgers()
  // Currency pairs traded should be specified as
  // [["USD@http://usd-ledger.example","EUR@http://eur-ledger.example"],...]
  let tradingPairs =
    JSON.parse(Config.getEnv(envPrefix, 'PAIRS') || 'false') || generateDefaultPairs(ledgers)

  const features = {}
  // Debug feature: Automatically fund connectors accounts using admin credentials
  features.debugAutoFund = Config.castBool(Config.getEnv(envPrefix, 'DEBUG_AUTOFUND'))
  // Debug feature: Reply to websocket notifications
  features.debugReplyNotifications =
    Config.castBool(Config.getEnv(envPrefix, 'DEBUG_REPLY_NOTIFICATIONS'))

  const adminEnv = parseAdminEnv()
  const useAdmin = adminEnv.username && (adminEnv.password || adminEnv.key)
  if (features.debugAutoFund && !useAdmin) {
    throw new Error(`${envPrefix}_DEBUG_AUTOFUND requires either ${envPrefix}_ADMIN_PASS or ${envPrefix}_ADMIN_KEY`)
  }

  const admin = useAdmin ? _.omitBy({
    username: adminEnv.username,
    password: adminEnv.password,
    key: adminEnv.key && fs.readFileSync(adminEnv.key),
    cert: adminEnv.cert && fs.readFileSync(adminEnv.cert),
    ca: adminEnv.ca && fs.readFileSync(adminEnv.ca)
  }, _.isUndefined) : undefined

  // Configure which backend we will use to determine
  // rates and execute payments. The list of available backends
  // can be found in src/backends
  const backend = Config.getEnv(envPrefix, 'BACKEND') || 'fixerio'

  const expiry = {}
  expiry.minMessageWindow =
    +Config.getEnv(envPrefix, 'MIN_MESSAGE_WINDOW') || DEFAULT_MIN_MESSAGE_WINDOW
  expiry.maxHoldTime = +Config.getEnv(envPrefix, 'MAX_HOLD_TIME') || DEFAULT_MAX_HOLD_TIME

  // The spread is added to every quoted rate
  const fxSpreadString = Config.getEnv(envPrefix, 'FX_SPREAD')
  const fxSpread = fxSpreadString ? +fxSpreadString : DEFAULT_FX_SPREAD

  const slippageString = Config.getEnv(envPrefix, 'SLIPPAGE')
  const slippage = slippageString ? +slippageString : DEFAULT_SLIPPAGE

  // BACKEND_URI must be defined for backends that connect to an external
  // component to retrieve the rate or amounts (it is therefore required
  // when using the ilp-quote backend)
  const backendUri = Config.getEnv(envPrefix, 'BACKEND_URI')

  const routeBroadcastInterval =
    Number(Config.getEnv(envPrefix, 'ROUTE_BROADCAST_INTERVAL')) || DEFAULT_ROUTE_BROADCAST_INTERVAL
  const routeCleanupInterval =
    Number(Config.getEnv(envPrefix, 'ROUTE_CLEANUP_INTERVAL')) || DEFAULT_ROUTE_CLEANUP_INTERVAL
  const routeExpiry =
    Number(Config.getEnv(envPrefix, 'ROUTE_EXPIRY')) || DEFAULT_ROUTE_EXPIRY

  // Credentials should be specified as a map of the form
  // {
  //    "<ledger_uri>": {
  //      "account_uri": "...",
  //      "username": "...",
  //      "password": "..."
  //    }
  // }
  let ledgerCredentials = {}
  let server = {}

  if (useTestConfig()) {
    server.base_uri = 'http://localhost'
    ledgerCredentials = require('../../test/data/ledgerCredentials.json')
    if (!tradingPairs.length) {
      tradingPairs = require('../../test/data/tradingPairs.json')
    }
    features.debugReplyNotifications = true
  } else {
    ledgerCredentials = parseCredentials()
  }

  const notifications = parseNotificationSignEnv()

  return {
    backend,
    ledgerCredentials,
    fxSpread,
    slippage,
    expiry,
    features,
    admin,
    tradingPairs,
    server,
    backendUri,
    notifications,
    routeBroadcastInterval,
    routeCleanupInterval,
    routeExpiry
  }
}

function loadConnectorConfig () {
  return Config.loadConfig(envPrefix, getLocalConfig(), {ed25519: false})
}

module.exports = loadConnectorConfig
