"use strict";

const path = require("path");
const CopyPlugin = require("copy-webpack-plugin");
const sqlWasmAsset = require("./src/sql-wasm-asset.json");

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
          from: sqlWasmAsset.runtimeSourcePath,
          to: sqlWasmAsset.runtimeFilename,
          info: { minimized: true },
        },
        {
          from: sqlWasmAsset.sourcePath,
          to: sqlWasmAsset.filename,
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
