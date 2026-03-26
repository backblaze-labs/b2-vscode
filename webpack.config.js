"use strict";

const path = require("path");
const CopyPlugin = require("copy-webpack-plugin");

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
    "sql.js": "commonjs sql.js",
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
          from: "node_modules/sql.js/dist/sql-wasm.wasm",
          to: "sql-wasm.wasm",
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
