"use strict";

const path = require("path");
const CopyPlugin = require("copy-webpack-plugin");

// Keep in sync with DEFAULT_SQL_WASM_FILENAME in src/services/authService.ts
// and PACKAGED_SQL_WASM_ENTRY in scripts/assert-vsix-assets.js.
const SQL_WASM_FILENAME = "sql-wasm.wasm";

/** @typedef {import('webpack').Configuration} WebpackConfig */

/** @type WebpackConfig */
const extensionConfig = {
  target: "node",
  mode: "none",
  entry: "./src/extension.ts",
  output: {
    path: path.resolve(__dirname, "dist"),
    filename: "extension.js",
    libraryTarget: "commonjs2",
  },
  externals: {
    vscode: "commonjs vscode",
  },
  resolve: {
    extensions: [".ts", ".js"],
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: [
          {
            loader: "ts-loader",
          },
        ],
      },
    ],
  },
  plugins: [
    new CopyPlugin({
      patterns: [
        {
          from: path.join("node_modules", "sql.js", "dist", SQL_WASM_FILENAME),
          to: SQL_WASM_FILENAME,
        },
      ],
    }),
  ],
  devtool: "nosources-source-map",
  infrastructureLogging: {
    level: "log",
  },
};

module.exports = [extensionConfig];
