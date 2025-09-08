// scripts/background_sw.js  (Manifest V3 service worker)

// ---- Bootstrap (MV3-safe) ---------------------------------------------------
self.browser = self.browser || chrome;
// Classic imports are allowed in MV3 service workers:
importScripts('crossbrowser.js', 'genlib.js', 'chromereload.js');

// ---- Constants / Flags ------------------------------------------------------
var TAB_AVAILABILITY_TIMEOUT = 150;
let planCheckTime = 864 * 1000 * 100; // one day
const isFirefox = typeof InstallTrigger !== 'undefined';
const isFirefoxBrowser = chrome.runtime.getURL('').startsWith('moz-extension://');
const isChromeBrowser = chrome.runtime.getURL('').startsWith('chrome-extension://');

let intialTab = 0;
var appConfigSettings = {};
let nextInvocationId = 0;
let port = null;
let portResolveList = {};
let fileaccessPort = null;
let params;
let totalSize;
let optionsTabId;
let imageURI = '';
let imagepath;
let errorConnect = false;
let fileaccessConnectError = false;
var activeOnTab = {};
var isUpdated = false;
const screenshotDelay = 3000;

const Base64 = { _keyStr:"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=",encode:function(e){var t="";var n,r,i,s,o,u,a;var f=0;e=Base64._utf8_encode(e);while(f<e.length){n=e.charCodeAt(f++);r=e.charCodeAt(f++);i=e.charCodeAt(f++);s=n>>2;o=(n&3)<<4|r>>4;u=(r&15)<<2|i>>6;a=i&63;if(isNaN(r)){u=a=64}else if(isNaN(i)){a=64}t=t+this._keyStr.charAt(s)+this._keyStr.charAt(o)+this._keyStr.charAt(u)+this._keyStr.charAt(a)}return t},decode:function(e){var t="";var n,r,i;var s,o,u,a;var f=0;e=e.replace(/[^A-Za-z0-9\+\/\=]/g,"");while(f<e.length){s=this._keyStr.indexOf(e.charAt(f++));o=this._keyStr.indexOf(e.charAt(f++));u=this._keyStr.indexOf(e.charAt(f++));a=this._keyStr.indexOf(e.charAt(f++));n=s<<2|o>>4;r=(o&15)<<4|u>>2;i=(u&3)<<6|a;t=t+String.fromCharCode(n);if(u!=64){t=t+String.fromCharCode(r)}if(a!=64){t=t+String.fromCharCode(i)}}t=Base64._utf8_decode(t);return t},_utf8_encode:function(e){e=e.replace(/\r\n/g,"\n");var t="";for(var n=0;n<e.length;n++){var r=e.charCodeAt(n);if(r<128){t+=String.fromCharCode(r)}else if(r>127&&r<2048){t+=String.fromCharCode(r>>6|192);t+=String.fromCharCode(r&63|128)}else{t+=String.fromCharCode(r>>12|224);t+=String.fromCharCode(r>>6&63|128);t+=String.fromCharCode(r&63|128)}}return t},_utf8_decode:function(e){var t="";var n=0;var r=c1=c2=0;while(n<e.length){r=e.charCodeAt(n);if(r<128){t+=String.fromCharCode(r);n++}else if(r>191&&r<224){c2=e.charCodeAt(n+1);t+=String.fromCharCode((r&31)<<6|c2&63);n+=2}else{c2=e.charCodeAt(n+1);c3=e.charCodeAt(n+2);t+=String.fromCharCode((r&15)<<12|(c2&63)<<6|c3&63);n+=3}}return t}};

// ---- Helpers ----------------------------------------------------------------
function deferred() {
  let thens = [], catches = [];
  let status, resolvedValue, rejectedError;
  return {
    resolve: v => { status='resolved'; resolvedValue=v; thens.forEach(t=>t(v)); thens=[]; },
    reject: e => { status='rejected'; rejectedError=e; catches.forEach(c=>c(e)); catches=[]; },
    then: cb => { status==='resolved' ? cb(resolvedValue) : thens.unshift(cb); },
    catch: cb => { status==='rejected' ? cb(rejectedError) : catches.unshift(cb); }
  }
}

const setBadge = (textLabel, tabId) => {
  browser.action.setBadgeText({ text: textLabel, tabId });
  if (textLabel) {
    browser.action.setBadgeBackgroundColor({ color: "#0366d6" });
    browser.action.setBadgeTextColor && browser.action.setBadgeTextColor({ color: "white" });
  }
};

const isLetter = (str) => { try { return str.match(/[a-z]/i); } catch(e){ return false } };

const invertSlashes = str => {
  let res = ''; for (let i=0;i<str.length;i++){ res += (str[i] === '/') ? '\\' : str[i]; } return res;
};

function onInstallActiveTab() {
  browser.tabs.query({}, function (tabs) {
    for (let i=0;i<tabs.length;i++){ const tab=tabs[i]; if (tab && tab.active && tab.id) intialTab = tab.id; }
  });
}

function enableIcon(tabId) {
  activeOnTab[tabId] = true;
  browser.action.enable(tabId);
}

function disableIcon(tabId) {
  activeOnTab[tabId] = false;
  browser.action.disable(tabId);
  browser.action.setIcon({
    'path': { "16":"images/copyfish-16.png","32":"images/copyfish-32.png","48":"images/copyfish-48.png","128":"images/copyfish-128.png" },
    tabId
  });
}

function updateIcons() {
  for (var tabId in activeOnTab) {
    if (activeOnTab.hasOwnProperty(tabId)) enableIcon(+tabId);
  }
  browser.tabs.query({}, function (tabs) {
    for (let i=0;i<tabs.length;i++) enableIcon(tabs[i].id);
  });
}

// ---- Native messaging connection --------------------------------------------
const onMessageReceiveFromDesktopCapture = (message) => { if (!message.result) { return; } };

function connectAsync() {
  errorConnect = false;
  port = browser.runtime.connectNative("com.a9t9.kantu.file_access");
  try {
    let imageCapturePort = browser.runtime.connectNative(NMHOST);
    imageCapturePort.onMessage.addListener(onMessageReceiveFromDesktopCapture);
    imageCapturePort.onDisconnect.addListener(function () { fileaccessConnectError = true; });
  } catch (e) { fileaccessConnectError = true; }

  port.onMessage.addListener(function (msg) {
    const id = msg.id;
    if (portResolveList[id]) { portResolveList[id](msg.result); delete portResolveList[id]; }

    // chunked file read for desktop capture
    if (msg.result && msg.result.exitCode === undefined) {
      try {
        if (typeof msg.result === 'object') {
          browser.storage.sync.get({ ocrEngine: 'OcrSpaceSecond' }, function (items) {
            imageURI = btoa(atob(imageURI) + atob(msg.result.buffer));
            if (msg.result.rangeEnd >= totalSize || msg.result.rangeEnd <= msg.result.rangeStart) {
              msg.result.buffer = imageURI;
              if (items.ocrEngine == "OcrLocal") {
                browser.tabs.sendMessage(optionsTabId, {
                  evt: 'desktopcaptureLocal', imagepath, ocrEngine: items.ocrEngine, result: msg.result
                });
              } else {
                browser.tabs.sendMessage(optionsTabId, {
                  evt: 'desktopcaptureData', imagepath, ocrEngine: items.ocrEngine, result: msg.result
                });
                invokeAsync("delete_file", { path: imagepath });
              }
            } else {
              params = { path: imagepath, rangeStart: msg.result.rangeEnd };
              invokeAsync("read_file_range", params);
            }
          });
        } else if (typeof msg.result === 'number') {
          totalSize = msg.result;
          invokeAsync("read_file_range", params);
        }
      } catch (e) { return false; }
    }
  });

  port.onDisconnect.addListener(function () { errorConnect = true; });
}
connectAsync();

function invokeAsync(method, params) {
  try {
    const id = nextInvocationId++;
    const requestObject = { id, method, params };
    return new Promise(resolve => {
      portResolveList[id] = resolve;
      port.postMessage(requestObject);
    });
  } catch (err) {
    console.log('invokeAsync error', err);
    return Promise.reject(err);
  }
}

// ---- File access helpers (unchanged logic) ----------------------------------
const getFileAccessVersion = () => {
  invokeAsync('get_version').then(result => browser.runtime.sendMessage({ evt: 'fileaccess_module_version', version: result }));
};
const checkOsisMac = () => navigator.platform.indexOf('Mac') > -1;

const fileaccessGetVersionLocal = () => {
  getLocalOcrPath().then(path => {
    const isMac = checkOsisMac();
    const filepath = isMac ? (path + '/ocr3') : (path + '\\ocrexe\\ocrcl1.exe');
    invokeAsync('get_version', { fileName: filepath })
      .then(result => browser.runtime.sendMessage({ evt: 'fileaccess_module_version_local', version: result }));
  })
};

const fetchLocalFiles = (fileUrl) => new Promise(resolve => {
  fetch(fileUrl).then(r => r.text()).then(resolve);
});

const getLocalOcrPath = () => new Promise(resolve => {
  invokeAsync('get_special_folder_path', 'UserProfile').then(folder => {
    if (navigator.platform.indexOf('Mac') > -1) resolve('/Library/uivision-xmodules/2.2.2/xmodules');
    else resolve(folder + '\\AppData\\Roaming\\UI.Vision\\XModules\\ocr');
  })
});

const testFileAccess = () => {
  var file;
  invokeAsync('get_special_folder_path', 'UserProfile')
    .then(folder => {
      file = folder + (folder[0] === '/' ? '/' : '\\') + 'a9t9fileaccesstest';
      return invokeAsync('write_all_text', { path: file, content: '' });
    })
    .then(writeOk => { if (writeOk) return invokeAsync('delete_file', { path: file }); return Promise.reject('can not create file'); })
    .then(deleteOk => {
      browser.runtime.sendMessage({ evt: 'fileaccess_module_test', result: !!deleteOk });
    })
    .catch(() => browser.runtime.sendMessage({ evt: 'fileaccess_module_test', result: false }));
};

const testFileAccessOcrLocal = () => {
  getLocalOcrPath().then(path => {
    const isMac = checkOsisMac();
    const filepath = isMac ? (path + '/ocr3') : (path + '\\ocrexe\\ocrcl1.exe');
    const targetpath = isMac ? (path + '/localfileaccesstest.txt') : (path + '\\localfileaccesstest.txt');
    params = { fileName: filepath, path: targetpath, content: '', waitForExit: true };
    invokeAsync('write_all_text', params)
      .then(writeOk => {
        if (writeOk) {
          const delParams = isMac ? { path: targetpath } : { fileName: filepath, path: targetpath };
          return invokeAsync('delete_file', delParams);
        }
      })
      .then(deleteOk => browser.runtime.sendMessage({ evt: 'fileaccess_module_test_local', result: !!deleteOk }))
      .catch(() => browser.runtime.sendMessage({ evt: 'fileaccess_module_test_local', result: false }));
  });
};

// ---- Desktop capture ---------------------------------------------------------
function captureScreen(beforeCb, afterCb, tabId) {
  if (errorConnect === false && fileaccessConnectError === false) {
    browser.tabs.sendMessage(tabId, { evt: 'getDevicePixelRatio' }, {}, (devicePixelRatio) => {
      browser.storage.sync.get(null, function (items) {
        let ocrEngine = items.ocrEngine;
        beforeCb && typeof beforeCb == 'function' && beforeCb();
        let takeScreenshot = { command: "saveScreenshot", scale: devicePixelRatio };
        browser.runtime.sendNativeMessage(NMHOST, takeScreenshot, ({ file, result }) => {
          if (result) {
            if (file) {
              browser.tabs.create({
                url: ocrEngine == "OcrLocal" ? browser.runtime.getURL('/ocrlocal.html') : browser.runtime.getURL('/screencapture.html')
              }, function (destTab) {
                setTimeout(() => {
                  optionsTabId = destTab.id;
                  imagepath = file; imageURI = "";
                  params = { path: imagepath, rangeStart: 0 };
                  invokeAsync("get_file_size", params);
                }, 1000);
              });
            }
            afterCb && typeof afterCb == 'function' && afterCb();
            return;
          }
          browser.notifications.create({
            type: 'basic', iconUrl: 'images/copyfish-48.png', title: "Desktop capture",
            message: `Please install external Shutter program first`
          });
          openXmoduleInstallOption();
        });
      });
    });
  } else {
    browser.notifications.create({
      type: 'basic', iconUrl: 'images/copyfish-48.png', title: "Desktop capture",
      message: `Please install the Copyfish Desktop Screenshot module first`
    });
    tabId ? openNativeAppNotSupprotedDialog(tabId) : openXmoduleInstallOption();
  }
}

// ---- Dialog + content resources ---------------------------------------------
function loadDialogFile(tabId) {
  return new Promise((resolve, reject) => {
    isTabAvailable(tabId).then(resolve).catch(() => {
      loadFiles(tabId).then(resolve).catch(reject);
    });
  });
}

function openNativeAppNotSupprotedDialog(tabId) {
  loadDialogFile(tabId).then(function () {
    setTimeout(function () {
      browser.tabs.sendMessage(tabId, { evt: 'show-message-dialog-native-app' }, {}, (response) => {
        if (!response) openExternalDialogNotSupported();
      });
    }, 1000);
  }, function () { openExternalDialogNotSupported(); });
}

function openExternalDialogNotSupported(forLoadingPopup, popupProp) {
  let url = "/message-dialog-special-page.html?forLoadingPopup=" + (forLoadingPopup || '');
  let w = (popupProp && popupProp.width) || 520;
  let h = (popupProp && popupProp.height) || 360;
  let left, top;
  try { left = (screen.width / 2) - (w / 2); top = (screen.height / 2) - (h / 2); } catch(e){}
  let windowCrt = browser.windows.create({
    url, type: "popup", height: parseInt(h), width: parseInt(w),
    top: parseInt(top) || 200, left: parseInt(left) || 430
  });
  if (windowCrt && windowCrt.then) {
    windowCrt.then(function(){}, () => openXmoduleInstallOption());
  }
}

function openXmoduleInstallOption() {
  setTimeout(function () {
    browser.runtime.openOptionsPage(function () {
      setTimeout(function () { browser.runtime.sendMessage({ message: "showXmoduleOption" }); }, 300);
    })
  }, 500);
}

// supports autotimeout: check if our content scripts are present
function isTabAvailable(tabId) {
  return new Promise(function (resolve, reject) {
    let isDefered = false;
    const doneOK  = ()=>{ isDefered=true; resolve(); };
    const doneBAD = ()=>{ isDefered=true; reject();  };
    browser.tabs.sendMessage(tabId, { evt:'isavailable' }, (resp) => {
      if (resp && resp.farewell === 'isavailable:OK') doneOK();
      else if (resp && resp.farewell === 'isavailable:FAIL') doneBAD();
    });
    setTimeout(function () { if (!isDefered) reject(); }, TAB_AVAILABILITY_TIMEOUT);
  });
}

// ---- Load config and initialize ---------------------------------------------
const configUrl = browser.runtime.getURL('config/config.json');

fetch(configUrl).then(r => r.json()).then(initConfigJson);

function initConfigJson(appConfig) {
  appConfigSettings = appConfig;

  // Simple in-sync DS for OCR API response times
  var OcrDS = (function () {
    var _maxResponseTime = 99;
    var _randNotEqual = function (serverList, server) {
      var idx = Math.floor(Math.random() * serverList.length);
      if (serverList.length === 1) return serverList[0];
      if (serverList[idx].id !== server.id) return serverList[idx];
      return _randNotEqual(serverList, server);
    };
    var _ocrDSAPI = {
      resetTime: appConfig.ocr_server_reset_time,
      currentBest: {},
      reset: function () {
        this.getAll().then(function (items) {
          if (Date.now() - (items.ocrServerLastReset || 0) > this.resetTime) {
            items.ocrServerList.forEach((server) => { server.responseTime = 0; });
          }
        });
      },
      getAll: function () {
        var $dfd = deferred();
        browser.storage.sync.get({ ocrServerLastReset: -1, ocrServerList: [] }, function (items) { $dfd.resolve(items); });
        return $dfd;
      },
      getBest: function () {
        var $dfd = deferred(), self = this;
        this.getAll().then(function (items) {
          var serverList = items.ocrServerList;
          var best = serverList[0];
          var allValuesSame = true;
          var cmp;
          serverList.forEach((s,i) => {
            if (i===0){ cmp = s.responseTime; return; }
            if (cmp !== s.responseTime) allValuesSame = false;
          });
          if (allValuesSame) {
            if (serverList[0].responseTime === 0) self.currentBest = serverList[0];
            else self.currentBest = _randNotEqual(serverList, self.currentBest);
            return $dfd.resolve(self.currentBest);
          }
          serverList.forEach((server) => { if (server.responseTime < best.responseTime) best = server; });
          self.currentBest = best; $dfd.resolve(self.currentBest);
        });
        return $dfd;
      },
      set: function (id, responseTime) {
        var $dfd = deferred();
        this.getAll().then(function (items) {
          var serverList = items.ocrServerList;
          if (responseTime === -1) responseTime = _maxResponseTime;
          serverList.forEach((server) => { if (id === server.id) { server.responseTime = responseTime; return false; } });
          browser.storage.sync.set({ ocrServerList: serverList }, function () { $dfd.resolve(); });
        });
        return $dfd;
      }
    };
    // init storage
    browser.storage.sync.get({ ocrServerLastReset: -1, ocrServerList: [] }, function (items) {
      if (items.ocrServerLastReset === -1) {
        const serverList = [];
        appConfig.ocr_api_list.forEach(api => serverList.push({ id: api.id, responseTime: 0 }));
        browser.storage.sync.set({ ocrServerList: serverList, ocrServerLastReset: Date.now() });
      } else { _ocrDSAPI.reset(); }
    });
    return _ocrDSAPI;
  }());

  // --- Context menus
  browser.contextMenus.create({ contexts:['action'], title:'Desktop Text Capture (Instant)', id:'capture-desktop' }, () => chrome.runtime.lastError);
  browser.contextMenus.create({ contexts:['action'], title:'Desktop Text Capture (3s delay)', id:'capture-desktop-delay' }, () => chrome.runtime.lastError);
  browser.contextMenus.create({ contexts:['action'], title:'Get image from clipboard', id:'clipboard_image' }, () => chrome.runtime.lastError);

  browser.contextMenus.create({ title: "Copyfish Get Text From Image", contexts: ["image"], id:"get-txt-from-img" });

  browser.contextMenus.onClicked.addListener(function (info, tab) {
    if (info.menuItemId === "clipboard_image") captureClipboardImage(info, tab);
    if (info.menuItemId === "get-txt-from-img") activate(tab, (tabId) => getTextFromImage(info.srcUrl, tabId));
    if (info.menuItemId === "capture-desktop") {
      captureScreen(() => setBadge('Desk', tab.id), () => setBadge('', tab.id), tab.id || '');
    }
    if (info.menuItemId === "capture-desktop-delay") {
      let interval = 0; let intr = setInterval(function () {
        interval++; setBadge(interval.toString(), tab.id);
        if (interval >= 4) { setBadge('', tab.id); clearInterval(intr);
          captureScreen(() => setBadge('Desk', tab.id), () => setBadge('', tab.id), tab.id || '');
        }
      }, 1000);
    }
  });

  function checkValidImgBase64(s) {
    let regex = /^\s*data:([a-z]+\/[a-z]+(;[a-z\-]+\=[a-z\-]+)?)?(;base64)?,[a-z0-9\!\$\&\'\,\(\)\*\+\,\;\=\-\.\_\~\:\@\/\?\%\s]*\s*$/i;
    return s.match(regex);
  }
  function toDataURL(url) {
    return new Promise(function (resolve) {
      (async () => {
        const response = await fetch(url);
        const imageBlob = await response.blob();
        const reader = new FileReader();
        reader.readAsDataURL(imageBlob);
        reader.onloadend = () => resolve(reader.result);
      })();
    });
  }

  function captureClipboardImage(info, tab) {
    try {
      if (isFirefoxBrowser) {
        // try content-side handler; fallback is a small popup auto-closing
        browser.tabs.sendMessage(tab.id || 0, { evt:'captureClipboard' }).catch(() => {
          let url = "/message-dialog-action-popup.html";
          browser.windows.create({ url, type:"popup", height:300, width:525, top:200, allowScriptsToClose:true })
            .then(w => setTimeout(() => browser.windows.remove(w.id), 5000)).catch(() => {});
        });
        return;
      }

      // Ensure content scripts are present
      isTabAvailable(tab.id).then(() => getImage(tab.id))
        .catch(() => loadFiles(tab.id).then(() => getImage(tab.id)));

      function createTabCallback(destTab, dataUri) {
        setTimeout(() => {
          optionsTabId = destTab.id;
          browser.tabs.sendMessage(optionsTabId, {
            evt: 'desktopcaptureData',
            result: dataUri, ocrText:'', overlayInfo:'', forExternalTab:0, translatedTextIfAny:'', currentZoomLevel:0
          });
        }, 1000);
      }

      function getImage(tabId) {
        browser.tabs.sendMessage(tabId, { evt:'captureClipboardChrome', data:'' }, function (src) {
          if (!src || !src[1]) { showWarningMessge(tabId, 'No image in clipboard'); return; }
          let ok = checkValidImgBase64(src[1]);
          if (!ok && src[1]) {
            toDataURL(src[1]).then((res) => {
              browser.tabs.create({ url: browser.runtime.getURL('/screencapture.html') }, (destTab) => createTabCallback(destTab, res));
            }, () => showWarningMessge(tabId, 'No image in clipboard'));
            return;
          } else if (!ok) {
            showWarningMessge(tabId, 'No image in clipboard'); return;
          }
          browser.tabs.create({ url: browser.runtime.getURL('/screencapture.html') }, (destTab) => createTabCallback(destTab, src[1]));
        });
      }
    } catch (err) { console.log(err); }
  }

  function showWarningMessge(tabId, message) {
    if (!tabId) {
      chrome.notifications.create({
        type:'basic', iconUrl:'images/copyfish-48.png', title:'OMNI PRO OCR', message: message || 'Notice'
      });
      return;
    }
    loadDialogFile(tabId).then(function () {
      browser.tabs.sendMessage(tabId, { evt:'show-warning', data: message || '' }, {}, function (response) {
        if (!response) {
          // Fallback: inject an alert function into the page
          chrome.scripting.executeScript({
            target: { tabId }, func: (msg)=>alert(msg), args: [message]
          });
        }
      });
    });
  }

  // storage bootstrap
  browser.storage.sync.get({
    visualCopyOCRLang:'', visualCopyTranslateLang:'', visualCopyAutoTranslate:'',
    visualCopyOCRFontSize:'', visualCopySupportDicts:'', useTableOcr:'',
    copyAfterProcess:'', copyType:'', visualCopyQuickSelectLangs:[], visualCopyTextOverlay:''
  }, function (items) {
    if (!items.visualCopyOCRLang) {
      browser.storage.sync.set(appConfig.defaults, function(){});
    } else {
      const itemsToBeSet = {};
      Object.entries(items).forEach(([k,v]) => { if (v === '') itemsToBeSet[k] = appConfig.defaults[k]; });
      if (Object.keys(itemsToBeSet).length) browser.storage.sync.set(itemsToBeSet, function(){});
    }
  });

  const changeIcon = (url, tabId) => {
    if (isUpdated) return setBadge('New', tabId);
    const storeOrInternal = (url && (/^moz\-extension\/\//.test(url) || /^about:/.test(url) || /^https:\/\/addons\.mozilla\.org\//.test(url))) ||
                            (url && (/^chrome\-extension:\/\//.test(url) || /^chrome:\/\//.test(url) || /^https:\/\/chrome\.google\.com\/webstore\//.test(url)));
    if (storeOrInternal) {
      browser.action.setIcon({ 'path': {
        "16":"images/copyfish-16.png","32":"images/copyfish-32.png","48":"images/copyfish-48.png","128":"images/copyfish-128.png"
      }, tabId });
    } else { setBadge('', tabId); }
  };

  browser.tabs.onUpdated.addListener(function (tabId, changeInfo, tab) {
    if (changeInfo && changeInfo.status === 'complete') {
      changeIcon(tab.url, tab.id); enableIcon(tabId);
    }
  });

  browser.tabs.onActivated.addListener(function (activeInfo) {
    browser.tabs.get(activeInfo.tabId, function (tab) { tab && changeIcon(tab.url || '', activeInfo.tabId); });
  });

  chrome.commands.onCommand.addListener(async (command, tab) => {
    if (tab == null) tab = await activeTabInfo();
    if (command === "desktop-text-capture-instant") {
      captureScreen(() => setBadge('Desk', tab.id), () => setBadge('', tab.id), tab.id || '');
    }
    if (command === "desktop-text-capture-3s-delay") {
      let interval = 0; let intr = setInterval(function () {
        interval++; setBadge(interval.toString(), tab.id);
        if (interval >= 4) { setBadge('', tab.id); clearInterval(intr);
          captureScreen(() => setBadge('Desk', tab.id), () => setBadge('', tab.id), tab.id || '');
        }
      }, 1000);
    }
    if (command === "get-image-from-clipboard") captureClipboardImage(tab, tab);
  });

  browser.action.onClicked.addListener(function (tab) { onActionClick(tab); });

  const activeTabInfo = () => new Promise(resolve => {
    chrome.tabs.query({ currentWindow:true, active:true }, function (tabs){ resolve(tabs[0]); });
  });

  const onActionClick = (tab) => {
    const url = tab.url || false;
    const storeOrInternal = (url && (/^moz\-extension\/\//.test(url) || /^about:/.test(url) || /^https:\/\/addons\.mozilla\.org\//.test(url))) ||
                            (url && (/^chrome\-extension:\/\//.test(url) || /^chrome:\/\//.test(url) || /^https:\/\/chrome\.google\.com\/webstore\//.test(url)));
    if (storeOrInternal) {
      if (isUpdated) { activate(tab); return; }
      captureScreen(() => setBadge('Desk', tab.id), () => setBadge('', tab.id), tab.id || '');
    } else {
      browser.storage.sync.get({ ocrEngine:'', useDefaultDesktopOcr:false }, function (result) {
        try {
          if (result && result.useDefaultDesktopOcr) {
            captureScreen(() => setBadge('Desk', tab.id), () => setBadge('', tab.id), tab.id || '');
          } else {
            activate(tab);
          }
        } catch (err) { activate(tab); }
      });
    }
  };

  function toDataUrl(url, callback) {
    (async () => {
      const response = await fetch(url);
      const imageBlob = await response.blob();
      const reader = new FileReader();
      reader.readAsDataURL(imageBlob);
      reader.onloadend = () => callback(reader.result);
    })();
  }

  const getTextFromImage = (srcUrl, tabId) => {
    if (srcUrl.indexOf('http://') !== -1 || srcUrl.indexOf('https://') !== -1) {
      toDataUrl('https://cors-anywhere.herokuapp.com/' + srcUrl, function (myBase64) { srcUrl = myBase64; });
    }
    browser.tabs.sendMessage(tabId, { evt:'image_for_parse', data: srcUrl });
  };

  function activate(tab, callback = false) {
    browser.tabs.sendMessage(tab.id, { evt:'disableselection' });
    if (isUpdated && !callback) {
      browser.tabs.create({ url: "https://ocr.space/copyfish/whatsnew?b=chrome" });
      isUpdated = false; updateIcons(); return;
    }
    isTabAvailable(tab.id).then(function () {
      browser.tabs.sendMessage(tab.id, { evt:'enableselection' });
      if (typeof callback === 'function') callback(tab.id);
    }).catch(() => {
      loadFiles(tab.id).then(function () {
        isTabAvailable(tab.id).then(function () {
          browser.tabs.sendMessage(tab.id, { evt:'enableselection' });
          if (typeof callback === 'function') callback(tab.id);
        }).catch(() => {
          openExternalDialogNotSupported('on', { height: 286 }); enableIcon(tab.id);
        });
      }).catch(() => {
        // MV3: no confirm() in SW; show a notification instead
        chrome.notifications.create({
          type:'basic', iconUrl:'images/copyfish-48.png',
          title:'OMNI PRO OCR', message: browser.i18n.getMessage('captureError') || 'Capture error'
        });
        enableIcon(tab.id);
      });
    });
  }

  // Message hub ---------------------------------------------------------------
  browser.runtime.onMessage.addListener(function (request, sender, sendResponse) {
    var tab = sender.tab;
    if (!tab) return false;

    if (request.evt === 'checkDesktopCaptureSoftware') {
      sendResponse(!errorConnect && !fileaccessConnectError);
    } else if (request.evt === 'captureScreen') {
      if (tab && tab.id) captureScreen(() => setBadge('Desk', tab.id), () => setBadge('', tab.id), tab.id || '');
      else captureScreen();
    } else if (request.evt === 'captureScreenLocalOcr') {
      getLocalOcrPath().then(path => {
        var lang = request.ocrLang;
        var base64result = request.imagepath.split(',')[1];
        const isMac = checkOsisMac();
        var filepath = isMac ? (path + '/ocr3') : (path + '\\ocrexe\\ocrcl1.exe');
        var targetpath = isMac ? (path + '/image.png') : (path + '\\image.png');
        params = { fileName: filepath, path: targetpath, content: base64result, waitForExit: true };
        invokeAsync('write_all_bytes', params)
          .then(res => {
            if (res) {
              if (isMac) {
                params = { arguments: '--in ' + path + "/image.png" + " --out " + path + "/ocr_output.json --lang " + lang, fileName: filepath, waitForExit: true };
              } else {
                params = { arguments: path + "\\image.png" + " " + path + "\\ocr_output.json " + lang, fileName: filepath, waitForExit: true };
              }
              return invokeAsync('run_process', params);
            } else { sendResponse({ result:false }); }
          })
          .then(res => {
            if (res && res.exitCode == 0) {
              invokeAsync("delete_file", { path: request.imagepath });
              const readPath = isMac ? (path + "/ocr_output.json") : (path + "\\ocr_output.json");
              return invokeAsync("read_all_bytes", { path: readPath, waitForExit: true });
            } else { sendResponse({ result:false }); }
          })
          .then(json => {
            if (json) {
              if (json.errorCode == 0) {
                let ocrOutput = Base64.decode(json.content);
                let OcrOutputJson = JSON.parse(ocrOutput);
                sendResponse({ result: OcrOutputJson });
              } else { sendResponse({ result:false }); }
            }
          })
          .catch(() => sendResponse({ result:false }));
      });
      return true;

    } else if (request.evt === 'fileaccessGetVersion')        getFileAccessVersion();
      else if (request.evt === 'fileaccessTest')              testFileAccess();
      else if (request.evt === 'fileaccessGetVersionLocal')   fileaccessGetVersionLocal();
      else if (request.evt === 'fileaccessTestOcrLocal')      testFileAccessOcrLocal();
      else if (request.evt === '_bootStrapResources') {
        (async()=>{
          let config = await fetchLocalFiles(browser.runtime.getURL('config/config.json'));
          let html   = await fetchLocalFiles(browser.runtime.getURL('/dialog.html'));
          sendResponse({ config, htmlStr: html });
        })(); return true;
      }
      else if (request.evt === '_bootStrapMessageDialog') {
        (async()=>{
          let html = await fetchLocalFiles(browser.runtime.getURL('/message-dialog.html'));
          sendResponse({ htmlStr: html });
        })(); return true;
      }
      else if (request.evt === 'getLocalOCRLangauges') {
        getLocalOcrPath().then(path => {
          const isMac = checkOsisMac();
          const filepath   = isMac ? (path + '/ocr3') : (path + '\\ocrexe\\ocrcl1.exe');
          const argumentsS = isMac ? (" --in get-installed-lng --out " + path + "/ocrlang.json") : ("get-installed-lng " + path + "\\ocrlang.json");
          const ocrOutputJson = isMac ? (path + "/ocrlang.json") : (path + "\\ocrlang.json");
          params = { arguments: argumentsS, fileName: filepath, waitForExit: true };
          invokeAsync('run_process', params).then(res => {
            if (res != undefined && res.exitCode > 0) {
              return invokeAsync("read_all_bytes", { path: ocrOutputJson, waitForExit: true });
            } else { sendResponse({ result:false }); }
          }).then(json => {
            if (json) {
              if (json.errorCode == 0) {
                let ocrLang = Base64.decode(json.content);
                let langJson = JSON.parse(ocrLang);
                sendResponse({ result: langJson });
              } else { sendResponse({ result:false }); }
            }
          }).catch(() => sendResponse({ result:false }));
        }); return true;

      } else if (request.evt === 'ready') {
        enableIcon(tab.id); sendResponse({ farewell:'ready:OK' }); return true;
      } else if (request.evt === 'checkKey') {
        checkPlanEveryDay();
      } else if (request.evt === 'activate') {
        activate(tab);
      } else if (request.evt === 'capture-screen') {
        browser.tabs.captureVisibleTab(function (dataURL) {
          browser.tabs.getZoom(tab.id, function (zf) { sendResponse({ dataURL, zf }); });
        }); return true;
      } else if (request.evt === 'capture-done') {
        enableIcon(tab.id); sendResponse({ farewell:'capture-done:OK' });
      } else if (request.evt === 'copy') {
        // On Chrome we copy from the content script. Nothing to do in SW.
        sendResponse({ farewell:'copy:OK' });
      } else if (request.evt === 'open-settings') {
        browser.tabs.create({ url: browser.runtime.getURL('options.html') }); sendResponse({ farewell:'open-settings:OK' });
      } else if (request.evt === 'get-best-server') {
        OcrDS.getBest().then(server => sendResponse({ server })); return true;
      } else if (request.evt === 'set-server-responsetime') {
        OcrDS.set(request.serverId, request.serverResponseTime).then(() => sendResponse({ farewell:'set-server-responsetime:OK' })); return true;
      } else if (request.evt === 'translateDesktopCapturedImage') {
        browser.tabs.sendMessage(sender.tab.id, {
          evt:"translateCapturedImage", data: request.data || null, imagepath: request.imagepath || null,
          ocrText: request.ocrText || '', overlayInfo: request.overlayInfo || '',
          forExternalTab: request.forExternalTab || 0, translatedTextIfAny: request.translatedTextIfAny || '',
          currentZoomLevel: request.currentZoomLevel || 0
        });
      } else if (request.evt === 'imageOcrInTab') {
        browser.tabs.create({ url: browser.runtime.getURL('/screencapture.html') }, function (destTab) {
          setTimeout(() => {
            optionsTabId = destTab.id;
            browser.tabs.sendMessage(optionsTabId, {
              evt:'desktopcaptureData', result: request.data, ocrText: request.ocrText || '',
              overlayInfo: request.overlayInfo || '', forExternalTab:1, translatedTextIfAny: request.translatedTextIfAny || '',
              currentZoomLevel: request.currentZoomLevel || 0
            });
          }, 3000);
        });
      } else if (request.evt === 'show-overlay-tab') {
        const overlayInfo = request.overlayInfo, imgDataURI = request.imgDataURI;
        browser.tabs.create({ url: browser.runtime.getURL('/overlay.html') }, function (destTab) {
          setTimeout(function () {
            browser.tabs.sendMessage(destTab.id, {
              evt:'init-overlay-tab', overlayInfo, imgDataURI,
              canWidth: request.canWidth, canHeight: request.canHeight
            }, function () { sendResponse({ farewell:'show-overlay-tab:OK' }); });
          }, 300);
        }); return true;
      } else if (request.evt === 'google-translate') {
        let OPTIONS = request.options; let text = request.text; const url = OPTIONS.google_trs_api_url;
        let _data = { key: OPTIONS.google_trs_api_key, target: OPTIONS.visualCopyTranslateLang, q: text };
        var queryString = Object.keys(_data).map(k => k + '=' + _data[k]).join('&');
        fetch(url + '?' + queryString, { method:"GET" }).then(r => r.ok ? r.json() : Promise.reject(r)).then(data => {
          if (data && data.data && data.data.translations && data.data.translations[0].translatedText != null) {
            sendResponse({ success:true, data: data.data.translations[0].translatedText });
          }
        }).catch((response) => {
          var errData; try { errData = JSON.parse(response.statusText); } catch(e){ errData = {}; }
          sendResponse({ success:false, data: errData, time: response.status });
        }); return true;

      } else if (request.evt === 'deepapi-translate') {
        let OPTIONS = request.options; let text = request.text; const url = OPTIONS.deepl_api_url;
        let _data = { auth_key: OPTIONS.deepl_api_key, target_lang: OPTIONS.visualCopyTranslateLang, text: text };
        var queryString = Object.keys(_data).map(k => k + '=' + _data[k]).join('&');
        fetch(url + '?' + queryString, { method:"GET" }).then(r => r.ok ? r.json() : Promise.reject(r)).then(data => {
          if (data && data.translations && data.translations[0] && data.translations[0].text != null) {
            sendResponse({ success:true, data: data.translations[0].text });
          }
        }).catch((response) => {
          var errData; try { errData = JSON.parse(response.statusText); } catch(e){ errData = {}; }
          sendResponse({ success:false, data: errData, time: response.status });
        });
      } else if (request.evt === 'google-ocr') {
        let OPTIONS = request.options;
        const url = OPTIONS.google_ocr_api_url + '?key=' + OPTIONS.google_ocr_api_key;
        const headers = { Accept:"application/json", "Content-Type":"application/json" };
        fetch(url, { method:"POST", headers, body: JSON.stringify(request.request) })
          .then(r => r.ok ? r.json() : Promise.reject(r))
          .then(json => sendResponse({ success:true, data: json }))
          .catch((response) => { console.log(response.status, response.statusText); sendResponse({ success:false, data: [] }); });
        return true;
      } else if (request.evt == 'show-warning') {
        // Content shows alert; nothing to do here for SW.
      } else if (request.evt == 'open-window') {
        request.url && browser.tabs.create({ url: request.url });
      } else if (request.evt == "runContentScript") {
        loadFiles(tab.id).then(function(){ sendResponse({ success:true }); });
        return true;
      } else if (request.evt == "show-warning-message") {
        showWarningMessge(tab.id, request.data && request.data.message);
      }
  });
}

// ---- Content resources loaders ----------------------------------------------
function loadFiles(tabId) {
  var files = [ "styles/material.min.css", "styles/cs.css", "scripts/jquery.min.js", "scripts/material.min.js", "scripts/overlay.js", "scripts/cs.js" ];
  var result = Promise.resolve();
  files.forEach(function (file) {
    result = result.then(function () { return (/css$/.test(file)) ? insertCSS(tabId, file) : executeScript(tabId, file); });
  });
  return result;
}
function insertCSS(tabId, file) {
  return new Promise(function (resolve) {
    browser.scripting.insertCSS({ target:{ tabId }, files:[file] }, function(){ resolve(); });
  });
}
function executeScript(tabId, file) {
  return new Promise(function (resolve) {
    browser.scripting.executeScript({ files:[file], target:{ allFrames:true, tabId } }, function(){ resolve(); });
  });
}

// ---- Plan check / license ----------------------------------------------------
function reloadOptionsPage(){ browser.runtime.sendMessage({ message:"reloadPage" }); }
const multipleKeySchemaCheckKey = {
  validKeyFound:false,
  urlSchema:[
    { url:'https://license1.ocr.space/api/status?licensekey=', legacy:false },
    { url:'https://ui.vision/xcopyfish/', legacy:true }
  ]
};

function checkKey(keyData, singleEntity = multipleKeySchemaCheckKey.urlSchema[0], iteration = 0) {
  try {
    checkLicenseKey(keyData, singleEntity.url, singleEntity.legacy).then(()=>{ iteration++; })
    .catch(()=>{ iteration++; if (iteration < multipleKeySchemaCheckKey.urlSchema.length) checkKey(keyData, multipleKeySchemaCheckKey.urlSchema[iteration], iteration); });
  } catch(err){}
}

function checkLicenseKey(keyData, urlApi = 'https://ui.vision/xcopyfish/', legacy = true) {
  return new Promise((resolve, reject) => {
    let key = keyData;
    let keyChar = key.substr(1, 9);
    if (key.length === 20) {
      if (key.charAt(1) === 'p') {
        let ApiUrl = legacy ? urlApi + keyChar + ".json" : urlApi + key.toUpperCase();
        fetch(ApiUrl, { method:"GET" }).then(r => r.ok ? r.json() : Promise.reject(r)).then((data) => {
          if (legacy) {
            if (data.google_ocr_api_key === 'freeplan') {
              browser.storage.sync.set({ status:"Free Plan", ocrEngine:"OcrSpace", transitionEngine:false, visualCopyAutoTranslate:false, visualCopyOCRLang:"eng" });
              browser.storage.sync.remove("key"); reloadOptionsPage(); browser.runtime.openOptionsPage();
              browser.notifications.create({ type:'basic', iconUrl:'images/copyfish-48.png', title:"It seems your PRO/PRO+ subscription is expire", message:`Copyfish will go back to the free mode. \n If you think this message is an error, please contact us at team@ocr.space`, silent:true });
            } else {
              browser.storage.sync.set({ visualCopyAutoTranslate:false });
              browser.storage.sync.set({ status:'PRO', google_ocr_api_url:data.google_ocr_api_url, google_ocr_api_key:data.google_ocr_api_key, deepl_api_url:data.deepl_api_url || '', deepl_api_key:data.deepl_api_key || '' });
            }
            resolve(data);
          } else {
            if (data && data.status == 'on') {
              browser.storage.sync.set({ status:'PRO', google_ocr_api_url:data.data1a, google_ocr_api_key:data.data1b, deepl_api_url:'', deepl_api_key:'' }); resolve(data);
            } else if (data && data.status == 'off') {
              browser.storage.sync.set({ status:"Subscription expired", ocrEngine:"OcrSpace", transitionEngine:false, visualCopyAutoTranslate:false, visualCopyOCRLang:"eng" });
              browser.storage.sync.remove("key"); reloadOptionsPage(); browser.runtime.openOptionsPage();
              browser.notifications.create({ type:'basic', iconUrl:'images/copyfish-48.png', title:"It seems your PRO/PRO+ subscription is expire", message:`Copyfish will go back to the free mode. \n If you think this message is an error, please contact us at team@ocr.space.com` });
              resolve(data);
            } else { reject(data); }
          }
        }).catch((res) => {
          if (res && res.status == 404 && legacy) {
            browser.storage.sync.set({ status:"Free Plan", ocrEngine:"OcrSpace", transitionEngine:false, visualCopyAutoTranslate:false, visualCopyOCRLang:"eng" });
            browser.storage.sync.remove("key"); reloadOptionsPage(); browser.runtime.openOptionsPage();
            browser.notifications.create({ type:'basic', iconUrl:'images/copyfish-48.png', title:"It seems your PRO/PRO+ subscription is expire", message:`Copyfish will go back to the free mode. \n If you think this message is an error, please contact us at team@ocr.space.com` });
          }
          reject('Invalid key');
        });
      } else if (key.charAt(1) === 't') {
        let ApiUrl = legacy ? urlApi + keyChar + ".json" : urlApi + key.toUpperCase();
        fetch(ApiUrl, { method:"GET" }).then(r => r.ok ? r.json() : Promise.reject(r)).then((data) => {
          if (legacy) {
            if (data.google_ocr_api_key === 'freeplan') {
              browser.storage.sync.set({ status:"Free Plan", ocrEngine:"OcrSpace", transitionEngine:false, visualCopyAutoTranslate:false, visualCopyOCRLang:"eng" });
              browser.storage.sync.remove("key"); reloadOptionsPage(); browser.runtime.openOptionsPage();
              browser.notifications.create({ type:'basic', iconUrl:'images/copyfish-48.png', title:"It seems your PRO/PRO+ subscription is expire", message:`Copyfish will go back to the free mode. \n If you think this message is an error, please contact us at team@ocr.space.com` });
            } else {
              browser.storage.sync.set({ key: key });
              browser.storage.sync.set({
                status:'PRO+',
                google_ocr_api_url:data.google_ocr_api_url, google_ocr_api_key:data.google_ocr_api_key,
                google_trs_api_url:data.google_trs_api_url || data.google_translation_api_url || appConfigSettings.google_translation_api_url || '',
                google_trs_api_key:data.google_trs_api_key,
                deepl_api_url:data.deepl_api_url || data.deepapi_translation_api_url || appConfigSettings.deepapi_translation_api_url || '',
                deepl_api_key:data.deepl_api_key || ''
              });
            }
          } else {
            if (data && data.status == 'on') {
              browser.storage.sync.set({ key: key });
              browser.storage.sync.set({
                status:'PRO+',
                google_ocr_api_url:data.data1a, google_ocr_api_key:data.data1b,
                google_trs_api_url: appConfigSettings.google_translation_api_url || '',
                google_trs_api_key: data.data2a,
                deepl_api_url: appConfigSettings.deepapi_translation_api_url || '',
                deepl_api_key: data.data2b || ''
              });
              resolve(data);
            } else if (data && data.status == 'off') {
              browser.storage.sync.set({ status:"Subscription expired", ocrEngine:"OcrSpace", transitionEngine:false, visualCopyAutoTranslate:false, visualCopyOCRLang:"eng" });
              browser.storage.sync.remove("key"); reloadOptionsPage(); browser.runtime.openOptionsPage();
              browser.notifications.create({ type:'basic', iconUrl:'images/copyfish-48.png', title:"It seems your PRO/PRO+ subscription is expire", message:`Copyfish will go back to the free mode. \n If you think this message is an error, please contact us at team@ocr.space.com` });
              resolve(data);
            } else { reject(data); }
          }
        }).catch((res) => {
          if (res && res.status == 404 && legacy) {
            browser.storage.sync.set({ status:"Free Plan", ocrEngine:"OcrSpace", transitionEngine:false, visualCopyAutoTranslate:false, visualCopyOCRLang:"eng" });
            browser.storage.sync.remove("key"); reloadOptionsPage(); browser.runtime.openOptionsPage();
            browser.notifications.create({ type:'basic', iconUrl:'images/copyfish-48.png', title:"It seems your PRO/PRO+ subscription is expire", message:`Copyfish will go back to the free mode. \n If you think this message is an error, please contact us at team@ocr.space` });
          }
          reject('Invalid key');
        });
      } else {
        browser.storage.sync.set({ status:"Free Plan", ocrEngine:"OcrSpace", transitionEngine:false, visualCopyAutoTranslate:false, visualCopyOCRLang:"eng" });
        browser.storage.sync.remove("key"); reloadOptionsPage(); browser.runtime.openOptionsPage();
        browser.notifications.create({ type:'basic', iconUrl:'images/copyfish-48.png', title:"It seems your PRO/PRO+ subscription is expire", message:`Copyfish will go back to the free mode. \n If you think this message is an error, please contact us at team@ocr.space` });
        reject('Invalid key');
      }
    } else {
      browser.storage.sync.set({ status:"Free Plan", ocrEngine:"OcrSpace", transitionEngine:false, visualCopyAutoTranslate:false, visualCopyOCRLang:"eng" });
      browser.storage.sync.remove("key"); reloadOptionsPage(); browser.runtime.openOptionsPage();
      browser.notifications.create({ type:'basic', iconUrl:'images/copyfish-48.png', title:"It seems your PRO/PRO+ subscription is expire", message:`Copyfish will go back to the free mode. \n If you think this message is an error, please contact us at team@ocr.space` });
      reject('Invalid key');
    }
  });
}

function checkPlanEveryDay() {
  browser.storage.sync.get(['lastPlanCheck', 'key'], function (result) {
    const currentDate = Date.now();
    if (result.key) {
      browser.storage.sync.set({ lastPlanCheck: currentDate });
      checkKey(result.key);
    }
  });
}
setInterval(checkPlanEveryDay, planCheckTime);
checkPlanEveryDay();

// ---- Install / update hooks --------------------------------------------------
browser.runtime.onInstalled.addListener(function (object) {
  onInstallActiveTab();
  if (object.reason === browser.runtime.OnInstalledReason.INSTALL) {
    try { if (isFirefoxBrowser) browser.storage.sync.clear(); } catch(e){}
    browser.tabs.create({ url: "https://ocr.space/copyfish/welcome?b=chrome" });
    updateIcons();
  } else if (object.reason === browser.runtime.OnInstalledReason.UPDATE) {
    isUpdated = true; updateIcons();
  }
});

// detect file access status
browser.extension.isAllowedFileSchemeAccess((status) => {
  browser.storage.sync.set({ fileAccessStatus: isFirefox ? true : status });
});
// Uninstall page
browser.runtime.setUninstallURL("https://ocr.space/copyfish/why?b=chrome");
