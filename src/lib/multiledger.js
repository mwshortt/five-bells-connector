'use strict'

const _ = require('lodash')
const healthStatus = require('../common/health.js')

function Multiledger (options) {
  this.config = options.config
  this.log = options.log('multiledger')
  this.makeLogger = options.log
  this.ledgers = this.buildLedgers()
  this.ledgersHealth = { ledgersHealth: healthStatus.statusNotOk }
}

Multiledger.prototype.getLedger = function (ledgerId) {
  return this.ledgers[ledgerId]
}

Multiledger.prototype.getLedgers = function () {
  return _.clone(this.ledgers)
}

Multiledger.prototype.buildLedgers = function () {
  const ledgers = {}
  Object.keys(this.config.get('ledgerCredentials')).forEach((ledgerId) => {
    const creds = this.config.getIn(['ledgerCredentials', ledgerId])

    if (creds.account_uri) {
      this.log.warn('DEPRECATED: The key `account_uri` in ledger credentials has been renamed `account`')
      creds.account = creds.account_uri
      delete creds.account_uri
    }

    creds.type = creds.type || 'bells'
    const LedgerPlugin = require('ilp-plugin-' + creds.type)
    ledgers[ledgerId] = new LedgerPlugin({
      id: ledgerId,
      auth: creds,
      debugReplyNotifications: this.config.features.debugReplyNotifications,
      debugAutofund: this.config.getIn(['features', 'debugAutoFund'])
        ? {
          admin: this.config.get('admin'),
          connector: this.config.getIn(['server', 'base_uri'])
        }
        : null,
      log: this.makeLogger('plugin-' + creds.type)
    })
  })
  return ledgers
}

Multiledger.prototype.getType = function (ledgerId) {
  return this.getLedger(ledgerId).constructor.TYPE
}

Multiledger.prototype.getStatus = function () {
  return _.every(this.ledgers, (ledger) => ledger.isConnected())
}

module.exports = Multiledger
