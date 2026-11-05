"use strict"
/**
 * Preload: exposes the `window.vibe` API the renderer (renderer/app.js) expects.
 * Every method is a thin IPC call to electron/backend.cjs; engine events arrive
 * on the "vibe:event" channel through onEvent().
 */
const { contextBridge, ipcRenderer } = require("electron")

const call = (name) => (arg) => ipcRenderer.invoke("vibe:" + name, arg)

const api = {
  // backend info
  info: call("info"),
  setMode: call("setMode"),

  // usage
  getAllUsage: call("getAllUsage"),
  clearSessionRules: call("clearSessionRules"),

  // browser control
  browserCreateTab: call("browserCreateTab"),
  browserCloseTab: call("browserCloseTab"),
  browserListTabs: call("browserListTabs"),
  browserCurrent: call("browserCurrent"),
  browserNavigate: call("browserNavigate"),
  browserScreenshot: call("browserScreenshot"),
  browserEvaluate: call("browserEvaluate"),
  browserSnapshot: call("browserSnapshot"),
  browserClick: call("browserClick"),
  browserFill: call("browserFill"),
  browserPress: call("browserPress"),
  browserScroll: call("browserScroll"),
  // Main-process agent commands are routed to the visible in-app browser dock.
  browserCommandResult: (payload) => ipcRenderer.invoke("vibe:browserCommandResult", payload),
  onBrowserCommand(cb) {
    if (typeof cb !== "function") return () => {}
    const h = (_event, payload) => {
      try { cb(payload) } catch {}
    }
    ipcRenderer.on("vibe:browser-command", h)
    return () => ipcRenderer.removeListener("vibe:browser-command", h)
  },

  // sessions
  listSessions: call("listSessions"),
  createSession: call("createSession"),
  getMessages: call("getMessages"),
  renameSession: call("renameSession"),
  deleteSession: call("deleteSession"),
  revertSession: call("revertSession"),
  undoSession: call("undoSession"),
  listSnapshots: call("listSnapshots"),
  listStepSnapshots: call("listStepSnapshots"),
  previewSnapshot: call("previewSnapshot"),
  undoStepSession: call("undoStepSession"),
  redoSession: call("redoSession"),
  listRedo: call("listRedo"),
  getTrail: call("getTrail"),

  // runs
  prompt: call("prompt"),
  resumeRun: call("resumeRun"),
  interrupt: call("interrupt"),
  compactSession: call("compactSession"),
  getCompactionSettings: call("getCompactionSettings"),
  setCompactionSettings: call("setCompactionSettings"),

  // background shell jobs
  listShells: call("listShells"),
  shellOutput: call("shellOutput"),
  shellInput: call("shellInput"),
  backgroundSession: call("backgroundSession"),
  backgroundShell: call("backgroundShell"),
  cancelShell: call("cancelShell"),

  // permissions
  setPermissions: call("setPermissions"),
  listPermissionRequests: call("listPermissionRequests"),
  replyPermission: call("replyPermission"),

  // question forms
  listForms: call("listForms"),
  replyForm: call("replyForm"),
  cancelForm: call("cancelForm"),

  // models / providers
  listModels: call("listModels"),
  listAllModels: call("listAllModels"),
  providerCatalog: call("providerCatalog"),
  listModelLimits: call("listModelLimits"),
  setModel: call("setModel"),
  providerList: call("providerList"),
  providerSave: call("providerSave"),
  providerRemove: call("providerRemove"),
  providerDisabled: call("providerDisabled"),
  providerKey: call("providerKey"),
  providerModels: call("providerModels"),
  providerModel: call("providerModel"),
  providerMeta: call("providerMeta"),

  // project / workspace
  cwd: call("cwd"),
  setDirectory: call("setDirectory"),
  getDirectory: call("getDirectory"),
  gitBranch: call("gitBranch"),
  pickProject: call("pickProject"),
  pickAttachments: call("pickAttachments"),
  readAttachment: call("readAttachment"),

  // agents + config pages
  ensureAgent: call("ensureAgent"),
  switchAgent: call("switchAgent"),
  listAgents: call("listAgents"),
  setAgentDisabled: call("setAgentDisabled"),
  mcpList: call("mcpList"),
  mcpAdd: call("mcpAdd"),
  mcpRemove: call("mcpRemove"),
  subagentCreate: call("subagentCreate"),
  subagentList: call("subagentList"),
  subagentStatus: call("subagentStatus"),
  subagentResult: call("subagentResult"),
  subagentDetails: call("subagentDetails"),
  subagentResume: call("subagentResume"),
  subagentStop: call("subagentStop"),
  subagentToggle: call("subagentToggle"),
  pluginList: call("pluginList"),
  pluginAdd: call("pluginAdd"),
  pluginRemove: call("pluginRemove"),
  builtins: call("builtins"),
  installBuiltinPlugin: call("installBuiltinPlugin"),
  removeBuiltinPlugin: call("removeBuiltinPlugin"),
  marketplace: call("marketplace"),
  installSkill: call("installSkill"),
  removeSkill: call("removeSkill"),
  importGitHubSkills: call("importGitHubSkills"),
  installCustomSkill: call("installCustomSkill"),
  removeCustomSkill: call("removeCustomSkill"),
  registryAdd: call("registryAdd"),
  registryRemove: call("registryRemove"),

  // memory + todos
  memoryPath: call("memoryPath"),
  memoryList: call("memoryList"),
  memoryAdd: call("memoryAdd"),
  memoryRemove: call("memoryRemove"),
  openMemoryFile: call("openMemoryFile"),
  todoList: call("todoList"),
  todoSave: call("todoSave"),

  // cli / account screens
  cliInfo: call("cliInfo"),
  cliInstallTested: call("cliInstallTested"),
  cliUpdateCheck: call("cliUpdateCheck"),
  authStatus: call("authStatus"),
  authConnect: call("authConnect"),
  authDisconnect: call("authDisconnect"),
  upgradeInfo: call("upgradeInfo"),
  startUpgrade: call("startUpgrade"),

  // misc
  ownerScan: call("ownerScan"),
  ownerVerify: call("ownerVerify"),
  notify: call("notify"),
  openExternal: call("openExternal"),
  restartEvents: call("restartEvents"),
  logError: call("logError"),
  openErrorLog: call("openErrorLog"),
  toast: (m) => ipcRenderer.invoke("vibe:notify", { title: "VibeCoder AI", body: String(m || "") }).catch(() => {}),

  // ---- desktop app auto-update (stable channel, production only) ----
  appUpdateStatus: call("appUpdateStatus"),
  appUpdateSetPrefs: call("appUpdateSetPrefs"),
  checkForAppUpdate: (arg) => ipcRenderer.invoke("vibe:appUpdateCheck", arg),
  downloadAppUpdate: () => ipcRenderer.invoke("vibe:appUpdateDownload"),
  installAppUpdate: () => ipcRenderer.invoke("vibe:appUpdateInstall"),
  onAppUpdateEvent(cb) {
    if (typeof cb !== "function") return () => {}
    const h = (_event, payload) => {
      try { cb(payload) } catch {}
    }
    ipcRenderer.on("vibe:app-update-event", h)
    return () => ipcRenderer.removeListener("vibe:app-update-event", h)
  },

  // live engine events -> renderer handlers
  onEvent(cb) {
    const h = (_e, payload) => {
      try {
        cb(payload)
      } catch {}
    }
    ipcRenderer.on("vibe:event", h)
    return () => ipcRenderer.removeListener("vibe:event", h)
  },
}

contextBridge.exposeInMainWorld("vibe", api)
