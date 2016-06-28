"use strict";

require('co-mocha');

const _ = require('underscore');
const genomatic = require('genomatic');
const Q = require('bluebird');
const fs = require('fs');
const Web3 = require('web3');
const shell = require('shelljs');
const path = require('path');
const packageJson = require('../package.json');
const gethPrivate = require('geth-private');
const Application = require('spectron').Application;

const chai = require('chai');
chai.should();

process.env.TEST_MODE = 'true';


exports.mocha = function(_module, options) {
  const tests = {};

  options = _.extend({
    app: 'mist'
  }, options);

  _module.exports[options.name || path.basename(_module.filename)] = {
    before: function*() {
      this.timeout(10000000);

      this.assert = chai.assert;
      this.expect = chai.expect;

      this.geth = gethPrivate({
        balance: 5,
        genesisBlock: {
          difficulty: '0x1',
          extraData: '0x1',
        },
        gethOptions: {
          port: 58546,
          rpcport: 58545,
        },
      });

      yield this.geth.start();

      this.web3 = new Web3(new Web3.providers.HttpProvider("http://localhost:58545"));

      const logFilePath = path.join(__dirname, 'mist.log');
      shell.rm('-rf', logFilePath);

      const appFileName = ('wallet' === options.app) ? 'Ethereum-Wallet' : 'Mist',
        appVers = packageJson.version.replace(/\./ig, '-'),
        platformArch = `${process.platform}-${process.arch}`;

      let appPath;

      switch (platformArch) {
        case 'darwin-x64':
          appPath = path.join(
            process.cwd(), 
            `dist_${options.app}`, 
            `${appFileName}-macosx-${appVers}`,
            `${appFileName}.app`,
            'Contents',
            'MacOS',
            appFileName
          );
          break;
        case 'linux-x64':
          appPath = path.join(
            process.cwd(), 
            `dist_${options.app}`, 
            `${appFileName}-linux64-${appVers}`,
            appFileName
          );
          break;
        default:
          throw new Error(`Cannot run tests on ${platformArch}, please run on: darwin-x64, linux-x64`)
      }

      // check that appPath exists
      if (!shell.test('-f', appPath)) {
        throw new Error('Cannot find binary: ' + appPath);
      }

      this.app = new Application({
        requireName: 'electronRequire',
        startTimeout: 5000,
        waitTimeout: 5000,
        quitTimeout: 10000,
        path: appPath,
        args: [
          '--mode', options.app, 
          '--loglevel', 'debug', 
          '--logfile', logFilePath, 
          '--node-datadir', this.geth.dataDir,
          '--ipcpath', path.join(this.geth.dataDir, 'geth.ipc')
        ],
      });

      yield this.app.start();

      this.client = this.app.client;

      yield this.client.waitUntilWindowLoaded();

      // wait a small amount of time to ensure main app window is ready with data
      yield Q.delay(8000);

      // console.log(this.app.chromeDriver.logLines);

      /*
      Utility methods
       */
      for (let key in Utils) {
        this[key] = genomatic.bind(Utils[key], this);
      }

      this.mainWindowHandle = (yield this.client.windowHandle()).value;
    },

    after: function*() {
      if (this.app && this.app.isRunning()) {
        yield this.app.stop();
      }

      if (this.geth && this.geth.isRunning) {
        yield this.geth.stop();
      }
    },

    tests: tests,
  };

  return tests;
};



const Utils = {
  waitUntil: function*(msg, promiseFn) {
    yield this.client.waitUntil(promiseFn, 
      10000, 
      msg, 
      500);
  },
  execElemMethod: function*(clientElementIdMethod, selector) {
    const elems = yield this.client.elements(selector);

    const values = yield elems.value.map(
      (e) => this.client[clientElementIdMethod](e.ELEMENT)
    );

    return values.map(r => r.value);
  },
  capturePage: function*() {
    let pageImage = yield this.app.browserWindow.capturePage();

    if (!pageImage) {
      throw new Error('Page capture failed');
    }

    fs.writeFileSync(path.join(__dirname, 'mist.png'), pageImage);
  },
  getRealAccountBalances: function*() {
    let accounts = this.web3.eth.accounts;

    let balances = accounts.map((acc) => 
      this.web3.fromWei(this.web3.eth.getBalance(acc), 'ether') + ''
    );

    accounts = accounts.map(a => a.toLowerCase());
    balances = balances.map(b => parseInt(b));

    return _.object(accounts, balances);
  },
  getUiAccountBalances: function*() {
    // check balances on the pgetUiAccountsBalancesage
    let _accounts = yield this.execElemMethod('elementIdText', '.wallet-box .account-id');
    let _balances = yield this.execElemMethod('elementIdText', '.wallet-box .account-balance');

    _accounts = _accounts.map(a => a.toLowerCase());
    _balances = _balances.map(b => parseInt(b));

    return _.object(_accounts, _balances);
  }
}


