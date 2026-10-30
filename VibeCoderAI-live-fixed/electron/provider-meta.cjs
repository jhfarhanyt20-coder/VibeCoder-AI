"use strict"
/** The provider URL repair + model metadata now lives in the engine source (core/llm/provider-meta.js),
 *  so every client gets the same behaviour. This shim keeps older requires working. */
module.exports = require("../core/llm/provider-meta")
