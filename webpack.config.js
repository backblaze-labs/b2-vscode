"use strict";

const path = require("path");
const CopyPlugin = require("copy-webpack-plugin");
const sqlWasmAsset = require("./src/sql-wasm-asset.json");

/** @typedef {import('webpack').Configuration} WebpackConfig */

/** @type WebpackConfig */
const baseConfig = {
  target: "node",
  mode: "none",
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
  node: {
    __dirname: false,
    __filename: false,
  },
  devtool: "nosources-source-map",
  infrastructureLogging: {
    level: "log",
  },
};

/** @type WebpackConfig */
const extensionConfig = {
  ...baseConfig,
  entry: "./src/extension.ts",
  output: {
    path: path.resolve(__dirname, "dist"),
    filename: "extension.js",
    libraryTarget: "commonjs2",
  },
  plugins: [
    new CopyPlugin({
      patterns: [
        {
          from: sqlWasmAsset.runtimeSourcePath,
          to: sqlWasmAsset.runtimeFilename,
          info: { minimized: true },
        },
        {
          from: sqlWasmAsset.wasmSourcePath,
          to: sqlWasmAsset.wasmFilename,
        },
      ],
    }),
  ],
};

/** @type WebpackConfig */
const bundledCredentialSmokeConfig = {
  ...baseConfig,
  entry: "./src/testSupport/bundledCredentialSmoke.ts",
  output: {
    path: path.resolve(__dirname, "dist"),
    filename: "bundledCredentialSmoke.js",
    libraryTarget: "commonjs2",
  },
};

module.exports = [extensionConfig, bundledCredentialSmokeConfig];
