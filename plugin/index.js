/* eslint-disable max-params, max-statements */
"use strict";

const _ = require("lodash/fp");
const os = require("os");
const path = require("path");
const most = require("most");
const webpack = require("webpack");
const SocketIOClient = require("socket.io-client");

const serializeError = require("../utils/error-serialization").serializeError;

const DEFAULT_PORT = 9838;
const DEFAULT_HOST = "127.0.0.1";
const ONE_SECOND = 1000;

const cacheFilename = path.resolve(os.homedir(), ".webpack-dashboard-cache.db");

function noop() {}

function getTimeMessage(timer) {
  let time = Date.now() - timer;

  if (time >= ONE_SECOND) {
    time /= ONE_SECOND;
    time = Math.round(time);
    time += "s";
  } else {
    time += "ms";
  }

  return ` (${time})`;
}

class DashboardPlugin {
  constructor(options) {
    if (typeof options === "function") {
      this.handler = options;
    } else {
      options = options || {};
      this.host = options.host || DEFAULT_HOST;
      this.port = options.port || DEFAULT_PORT;
      this.root = options.root;
      this.handler = options.handler || null;
    }

    this.cleanup = this.cleanup.bind(this);

    this.watching = false;
  }

  cleanup() {
    if (!this.watching && this.socket) {
      this.handler = null;
      this.socket.close();
    }
  }

  apply(compiler) {
    let handler = this.handler;
    let timer;

    // Enable pathinfo for inspectpack support
    compiler.options.output.pathinfo = true;

    // Safely get the node env if specified in the webpack config
    const definePlugin = compiler.options.plugins
      .filter(plugin => plugin.constructor.name === "DefinePlugin")[0];
    const nodeEnv = JSON.parse(
      _.getOr("\"development\"")(["definitions", "process.env", "NODE_ENV"])(definePlugin));

    if (!handler) {
      handler = noop;
      const port = this.port;
      const host = this.host;
      this.socket = new SocketIOClient(`http://${host}:${port}`);
      this.socket.on("connect", () => {
        handler = this.socket.emit.bind(this.socket, "message");
        handler([{ type: "nodeEnv", value: nodeEnv }]);
      });
      this.socket.once("mode", args => {
        this.minimal = args.minimal;
      });
    }

    compiler.apply(
      new webpack.ProgressPlugin((percent, msg) => {
        handler([
          {
            type: "status",
            value: "Compiling"
          },
          {
            type: "progress",
            value: percent
          },
          {
            type: "operations",
            value: msg + getTimeMessage(timer)
          }
        ]);
      })
    );

    compiler.plugin("watch-run", (c, done) => {
      this.watching = true;
      done();
    });

    compiler.plugin("run", (c, done) => {
      this.watching = false;
      done();
    });

    compiler.plugin("compile", () => {
      timer = Date.now();
      handler([
        {
          type: "status",
          value: "Compiling"
        }
      ]);
    });

    compiler.plugin("invalid", () => {
      handler([
        {
          type: "status",
          value: "Invalidated"
        },
        {
          type: "progress",
          value: 0
        },
        {
          type: "operations",
          value: "idle"
        },
        {
          type: "clear"
        }
      ]);
    });

    compiler.plugin("failed", () => {
      handler([
        {
          type: "status",
          value: "Failed"
        },
        {
          type: "operations",
          value: `idle${getTimeMessage(timer)}`
        }
      ]);
    });

    compiler.plugin("done", stats => {
      const options = stats.compilation.options;
      const statsOptions =
        options.devServer && options.devServer.stats ||
        options.stats ||
        { colors: true };

      handler([
        {
          type: "status",
          value: "Success"
        },
        {
          type: "progress",
          value: 0
        },
        {
          type: "operations",
          value: `idle${getTimeMessage(timer)}`
        },
        {
          type: "stats",
          value: {
            errors: stats.hasErrors(),
            warnings: stats.hasWarnings(),
            data: stats.toJson()
          }
        },
        {
          type: "log",
          value: stats.toString(statsOptions)
        }
      ]);
    });
  }

  /**
   * Infer the root of the project, w/ package.json + node_modules.
   *
   * Inspectpack's `version` option needs to know where to start resolving
   * packages from to translate `~/lodash/index.js` to
   * `/ACTUAL/PATH/node_modules/index.js`.
   *
   * In common practice, this is _usually_ `bundle.context`, but sometimes folks
   * will set that to a _different_ directory of assets directly copied in or
   * something.
   *
   * To handle varying scenarios, we resolve the project's root as:
   * 1. Plugin `root` option, if set
   * 2. `bundle.context`, if `package.json` exists
   * 3. `process.cwd()`, if `package.json` exists
   * 4. `null` if nothing else matches
   *
   * @param {Object} bundle Bundle
   * @returns {String|null} Project root path or null
   */
  getProjectRoot(bundle) {
    /*eslint-disable global-require*/
    // Start with plugin option (and don't check it).
    // We **will** allow a bad project root to blow up webpack-dashboard.
    if (this.root) {
      return this.root;
    }

    // Try bundle context.
    try {
      if (bundle.context && require(path.join(bundle.context, "package.json"))) {
        return bundle.context;
      }
    } catch (err) { /* passthrough */ }

    // Try CWD.
    try {
      if (require(path.resolve("package.json"))) {
        return process.cwd();
      }
    } catch (err) { /* passthrough */ }

    // A null will be filtered out, disabling `versions` action.
    return null;
  }
}

module.exports = DashboardPlugin;
