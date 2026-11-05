"use strict"
/** Native VibeCore playbook facade. Compatibility formats remain discoverable. */
const store = require("../skills")

module.exports = {
  list: store.listPlaybooks,
  get: store.getPlaybook,
  load: store.loadPlaybook,
  systemText: store.systemText,
  install: store.installPlaybookFile,
}
