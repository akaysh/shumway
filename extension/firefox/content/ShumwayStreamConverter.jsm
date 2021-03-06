/*
 * Copyright 2013 Mozilla Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

var EXPORTED_SYMBOLS = ['ShumwayStreamConverter', 'ShumwayStreamOverlayConverter'];

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cr = Components.results;
const Cu = Components.utils;

const SHUMWAY_CONTENT_TYPE = 'application/x-shockwave-flash';
const EXPECTED_PLAYPREVIEW_URI_PREFIX = 'data:application/x-moz-playpreview;,' +
                                        SHUMWAY_CONTENT_TYPE;

const FIREFOX_ID = '{ec8030f7-c20a-464f-9b0e-13a3a9e97384}';
const SEAMONKEY_ID = '{92650c4d-4b8e-4d2a-b7eb-24ecf4f6b63a}';

Cu.import('resource://gre/modules/XPCOMUtils.jsm');
Cu.import('resource://gre/modules/Services.jsm');
Cu.import('resource://gre/modules/NetUtil.jsm');

XPCOMUtils.defineLazyModuleGetter(this, 'PrivateBrowsingUtils',
  'resource://gre/modules/PrivateBrowsingUtils.jsm');

XPCOMUtils.defineLazyModuleGetter(this, 'ShumwayTelemetry',
  'resource://shumway/ShumwayTelemetry.jsm');

function getBoolPref(pref, def) {
  try {
    return Services.prefs.getBoolPref(pref);
  } catch (ex) {
    return def;
  }
}

function log(aMsg) {
  let msg = 'ShumwayStreamConverter.js: ' + (aMsg.join ? aMsg.join('') : aMsg);
  Services.console.logStringMessage(msg);
  dump(msg + '\n');
}

function getDOMWindow(aChannel) {
  var requestor = aChannel.notificationCallbacks ||
                  aChannel.loadGroup.notificationCallbacks;
  var win = requestor.getInterface(Components.interfaces.nsIDOMWindow);
  return win;
}

function parseQueryString(qs) {
  if (!qs)
    return {};

  if (qs.charAt(0) == '?')
    qs = qs.slice(1);

  var values = qs.split('&');
  var obj = {};
  for (var i = 0; i < values.length; i++) {
    var kv = values[i].split('=');
    var key = kv[0], value = kv[1];
    obj[decodeURIComponent(key)] = decodeURIComponent(value);
  }

  return obj;
}

function isContentWindowPrivate(win) {
  if (!('isContentWindowPrivate' in PrivateBrowsingUtils)) {
    return PrivateBrowsingUtils.isWindowPrivate(win);
  }
  return PrivateBrowsingUtils.isContentWindowPrivate(win);
}

function isShumwayEnabledFor(startupInfo) {
  // disabled for PrivateBrowsing windows
  if (isContentWindowPrivate(startupInfo.window) &&
      !getBoolPref('shumway.enableForPrivate', false)) {
    return false;
  }
  // disabled if embed tag specifies shumwaymode (for testing purpose)
  if (startupInfo.objectParams['shumwaymode'] === 'off') {
    return false;
  }

  var url = startupInfo.url;
  var baseUrl = startupInfo.baseUrl;

  // blacklisting well known sites with issues
  if (/\.ytimg\.com\//i.test(url) /* youtube movies */ ||
    /\/vui.swf\b/i.test(url) /* vidyo manager */  ||
    /soundcloud\.com\/player\/assets\/swf/i.test(url) /* soundcloud */ ||
    /sndcdn\.com\/assets\/swf/.test(url) /* soundcloud */ ||
    /vimeocdn\.com/.test(url) /* vimeo */) {
    return false;
  }

  return true;
}

var ActivationQueue = {
  nonActive: [],
  initializing: -1,
  activationTimeout: null,
  get currentNonActive() {
    return this.nonActive[this.initializing].startupInfo;
  },
  enqueue: function ActivationQueue_enqueue(startupInfo, callback) {
    this.nonActive.push({startupInfo: startupInfo, callback: callback});
    if (this.nonActive.length === 1) {
      this.activateNext();
    }
  },
  findLastOnPage: function ActivationQueue_findLastOnPage(baseUrl) {
    for (var i = this.nonActive.length - 1; i >= 0; i--) {
      if (this.nonActive[i].startupInfo.baseUrl === baseUrl) {
        return this.nonActive[i].startupInfo;
      }
    }
    return null;
  },
  activateNext: function ActivationQueue_activateNext() {
    function weightInstance(startupInfo) {
      // set of heuristics for find the most important instance to load
      var weight = 0;
      // using linear distance to the top-left of the view area
      if (startupInfo.embedTag) {
        var window = startupInfo.window;
        var clientRect = startupInfo.embedTag.getBoundingClientRect();
        weight -= Math.abs(clientRect.left - window.scrollX) +
                  Math.abs(clientRect.top - window.scrollY);
      }
      var doc = startupInfo.window.document;
      if (!doc.hidden) {
        weight += 100000; // might not be that important if hidden
      }
      if (startupInfo.embedTag &&
          startupInfo.embedTag.ownerDocument.hasFocus()) {
        weight += 10000; // parent document is focused
      }
      return weight;
    }

    if (this.activationTimeout) {
      this.activationTimeout.cancel();
      this.activationTimeout = null;
    }

    if (this.initializing >= 0) {
      this.nonActive.splice(this.initializing, 1);
    }
    var weights = [];
    for (var i = 0; i < this.nonActive.length; i++) {
      try {
        var weight = weightInstance(this.nonActive[i].startupInfo);
        weights.push(weight);
      } catch (ex) {
        // unable to calc weight the instance, removing
        log('Shumway instance weight calculation failed: ' + ex);
        this.nonActive.splice(i, 1);
        i--;
      }
    }

    do {
      if (this.nonActive.length === 0) {
        this.initializing = -1;
        return;
      }

      var maxWeightIndex = 0;
      var maxWeight = weights[0];
      for (var i = 1; i < weights.length; i++) {
        if (maxWeight < weights[i]) {
          maxWeight = weights[i];
          maxWeightIndex = i;
        }
      }
      try {
        this.initializing = maxWeightIndex;
        this.nonActive[maxWeightIndex].callback();
        break;
      } catch (ex) {
        // unable to initialize the instance, trying another one
        log('Shumway instance initialization failed: ' + ex);
        this.nonActive.splice(maxWeightIndex, 1);
        weights.splice(maxWeightIndex, 1);
      }
    } while (true);

    var ACTIVATION_TIMEOUT = 3000;
    this.activationTimeout = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
    this.activationTimeout.initWithCallback(function () {
      log('Timeout during shumway instance initialization');
      this.activateNext();
    }.bind(this), ACTIVATION_TIMEOUT, Ci.nsITimer.TYPE_ONE_SHOT);
  }
};

function activateShumwayScripts(window) {
  function initScripts() {
    window.wrappedJSObject.runViewer();

    var parentWindow = window.parent;
    var viewerWindow = window.viewer.contentWindow;

    function activate(e) {
      e.preventDefault();
      viewerWindow.removeEventListener('mousedown', activate, true);

      parentWindow.addEventListener('keydown', forwardKeyEvent, true);
      parentWindow.addEventListener('keyup', forwardKeyEvent, true);

      sendFocusEvent('focus');

      parentWindow.addEventListener('blur', deactivate, true);
      parentWindow.addEventListener('mousedown', deactivate, true);
      viewerWindow.addEventListener('unload', deactivate, true);
    }

    function deactivate() {
      parentWindow.removeEventListener('blur', deactivate, true);
      parentWindow.removeEventListener('mousedown', deactivate, true);
      viewerWindow.removeEventListener('unload', deactivate, true);

      parentWindow.removeEventListener('keydown', forwardKeyEvent, true);
      parentWindow.removeEventListener('keyup', forwardKeyEvent, true);

      sendFocusEvent('blur');

      viewerWindow.addEventListener('mousedown', activate, true);
    }

    function forwardKeyEvent(e) {
      var event = viewerWindow.document.createEvent('KeyboardEvent');
      event.initKeyEvent(e.type,
                         e.bubbles,
                         e.cancelable,
                         e.view,
                         e.ctrlKey,
                         e.altKey,
                         e.shiftKey,
                         e.metaKey,
                         e.keyCode,
                         e.charCode);
      viewerWindow.dispatchEvent(event);
    }

    function sendFocusEvent(type) {
      var event = viewerWindow.document.createEvent("UIEvent");
      event.initEvent(type, false, true);
      viewerWindow.dispatchEvent(event);
    }

    if (viewerWindow) {
      viewerWindow.addEventListener('mousedown', activate, true);
    }

    window.addEventListener('shumwayFallback', function (e) {
      var automatic = !!e.detail.automatic;
      fallbackToNativePlugin(window, !automatic, automatic);
    });

    window.addEventListener('shumwayActivated', function (e) {
      if (ActivationQueue.currentNonActive &&
          ActivationQueue.currentNonActive.window === window) {
        ActivationQueue.activateNext();
      }
    });
  }

  if (window.document.readyState === "interactive" ||
      window.document.readyState === "complete") {
    initScripts();
  } else {
    window.document.addEventListener('DOMContentLoaded', initScripts);
  }
}

function fallbackToNativePlugin(window, userAction, activateCTP) {
  var obj = window.frameElement;
  var doc = obj.ownerDocument;
  var e = doc.createEvent("CustomEvent");
  e.initCustomEvent("MozPlayPlugin", true, true, activateCTP);
  obj.dispatchEvent(e);

  ShumwayTelemetry.onFallback(userAction);
}

function ShumwayStreamConverterBase() {
}

ShumwayStreamConverterBase.prototype = {
  QueryInterface: XPCOMUtils.generateQI([
      Ci.nsISupports,
      Ci.nsIStreamConverter,
      Ci.nsIStreamListener,
      Ci.nsIRequestObserver
  ]),

  /*
   * This component works as such:
   * 1. asyncConvertData stores the listener
   * 2. onStartRequest creates a new channel, streams the viewer and cancels
   *    the request so Shumway can do the request
   * Since the request is cancelled onDataAvailable should not be called. The
   * onStopRequest does nothing. The convert function just returns the stream,
   * it's just the synchronous version of asyncConvertData.
   */

  // nsIStreamConverter::convert
  convert: function(aFromStream, aFromType, aToType, aCtxt) {
    throw Cr.NS_ERROR_NOT_IMPLEMENTED;
  },

  getUrlHint: function(requestUrl) {
    return requestUrl.spec;
  },

  getStartupInfo: function(window, urlHint) {
    var url = urlHint;
    var baseUrl;
    var pageUrl;
    var element = window.frameElement;
    var isOverlay = false;
    var objectParams = {};
    if (element) {
      // PlayPreview overlay "belongs" to the embed/object tag and consists of
      // DIV and IFRAME. Starting from IFRAME and looking for first object tag.
      var tagName = element.nodeName, containerElement;
      while (tagName != 'EMBED' && tagName != 'OBJECT') {
        // plugin overlay skipping until the target plugin is found
        isOverlay = true;
        containerElement = element;
        element = element.parentNode;
        if (!element) {
          throw new Error('Plugin element is not found');
        }
        tagName = element.nodeName;
      }

      if (isOverlay) {
        // HACK For Facebook, CSS embed tag rescaling -- iframe (our overlay)
        // has no styling in document. Shall removed with jsplugins.
        for (var child = window.frameElement; child !== element; child = child.parentNode) {
          child.setAttribute('style', 'max-width: 100%; max-height: 100%');
        }

        // Checking if overlay is a proper PlayPreview overlay.
        for (var i = 0; i < element.children.length; i++) {
          if (element.children[i] === containerElement) {
            throw new Error('Plugin element is invalid');
          }
        }
      }
    }

    if (element) {
      // Getting absolute URL from the EMBED tag
      url = element.srcURI && element.srcURI.spec;

      pageUrl = element.ownerDocument.location.href; // proper page url?

      if (tagName == 'EMBED') {
        for (var i = 0; i < element.attributes.length; ++i) {
          var paramName = element.attributes[i].localName.toLowerCase();
          objectParams[paramName] = element.attributes[i].value;
        }
      } else {
        for (var i = 0; i < element.childNodes.length; ++i) {
          var paramElement = element.childNodes[i];
          if (paramElement.nodeType != 1 ||
              paramElement.nodeName != 'PARAM') {
            continue;
          }
          var paramName = paramElement.getAttribute('name').toLowerCase();
          objectParams[paramName] = paramElement.getAttribute('value');
        }
      }
    }

    if (!url) { // at this point url shall be known -- asserting
      throw new Error('Movie url is not specified');
    }

    if (objectParams.base) {
        baseUrl = Services.io.newURI(objectParams.base, null, pageUrl).spec;
    } else {
        baseUrl = pageUrl;
    }

    var movieParams = {};
    if (objectParams.flashvars) {
      movieParams = parseQueryString(objectParams.flashvars);
    }
    var queryStringMatch = /\?([^#]+)/.exec(url);
    if (queryStringMatch) {
      var queryStringParams = parseQueryString(queryStringMatch[1]);
      for (var i in queryStringParams) {
        if (!(i in movieParams)) {
          movieParams[i] = queryStringParams[i];
        }
      }
    }

    var allowScriptAccess = false;
    switch (objectParams.allowscriptaccess || 'sameDomain') {
    case 'always':
      allowScriptAccess = true;
      break;
    case 'never':
      allowScriptAccess = false;
      break;
    default:
      if (!pageUrl)
        break;
      try {
        // checking if page is in same domain (? same protocol and port)
        allowScriptAccess =
          Services.io.newURI('/', null, Services.io.newURI(pageUrl, null, null)).spec ==
          Services.io.newURI('/', null, Services.io.newURI(url, null, null)).spec;
      } catch (ex) {}
      break;
    }

    var startupInfo = {};
    startupInfo.window = window;
    startupInfo.url = url;
    startupInfo.objectParams = objectParams;
    startupInfo.movieParams = movieParams;
    startupInfo.baseUrl = baseUrl || url;
    startupInfo.isOverlay = isOverlay;
    startupInfo.embedTag = element;
    startupInfo.isPausedAtStart = /\bpaused=true$/.test(urlHint);
    startupInfo.allowScriptAccess = allowScriptAccess;
    startupInfo.pageIndex = 0;
    return startupInfo;
  },

  // nsIStreamConverter::asyncConvertData
  asyncConvertData: function(aFromType, aToType, aListener, aCtxt) {
    // Store the listener passed to us
    this.listener = aListener;
  },

  // nsIStreamListener::onDataAvailable
  onDataAvailable: function(aRequest, aContext, aInputStream, aOffset, aCount) {
    // Do nothing since all the data loading is handled by the viewer.
    log('SANITY CHECK: onDataAvailable SHOULD NOT BE CALLED!');
  },

  // nsIRequestObserver::onStartRequest
  onStartRequest: function(aRequest, aContext) {
    // Setup the request so we can use it below.
    aRequest.QueryInterface(Ci.nsIChannel);

    aRequest.QueryInterface(Ci.nsIWritablePropertyBag);

    // Change the content type so we don't get stuck in a loop.
    aRequest.setProperty('contentType', aRequest.contentType);
    aRequest.contentType = 'text/html';

    // TODO For now suspending request, however we can continue fetching data
    aRequest.suspend();

    var originalURI = aRequest.URI;

    // Create a new channel that loads the viewer as a chrome resource.
    var viewerUrl = 'chrome://shumway/content/viewer.wrapper.html';
    var channel = Services.io.newChannel(viewerUrl, null, null);

    var converter = this;
    var listener = this.listener;
    // Proxy all the request observer calls, when it gets to onStopRequest
    // we can get the dom window.
    var proxy = {
      onStartRequest: function(request, context) {
        listener.onStartRequest(aRequest, context);
      },
      onDataAvailable: function(request, context, inputStream, offset, count) {
        listener.onDataAvailable(aRequest, context, inputStream, offset, count);
      },
      onStopRequest: function(request, context, statusCode) {
        // Cancel the request so the viewer can handle it.
        aRequest.resume();
        aRequest.cancel(Cr.NS_BINDING_ABORTED);

        var domWindow = getDOMWindow(channel);
        let startupInfo = converter.getStartupInfo(domWindow,
                                                   converter.getUrlHint(originalURI));
        if (!isShumwayEnabledFor(startupInfo)) {
          fallbackToNativePlugin(domWindow, false, true);
          return;
        }

        domWindow.shumwayStartupInfo = startupInfo;

        // Report telemetry on amount of swfs on the page
        if (startupInfo.isOverlay) {
          // Looking for last actions with same baseUrl
          var prevPageStartupInfo = ActivationQueue.findLastOnPage(startupInfo.baseUrl);
          var pageIndex = !prevPageStartupInfo ? 1 : (prevPageStartupInfo.pageIndex + 1);
          startupInfo.pageIndex = pageIndex;
          ShumwayTelemetry.onPageIndex(pageIndex);
        } else {
          ShumwayTelemetry.onPageIndex(0);
        }

        ActivationQueue.enqueue(startupInfo, function(domWindow) {
          activateShumwayScripts(domWindow);
        }.bind(null, domWindow));

        listener.onStopRequest(aRequest, context, statusCode);
      }
    };

    // Keep the URL the same so the browser sees it as the same.
    channel.originalURI = aRequest.URI;
    channel.loadGroup = aRequest.loadGroup;

    // We can use all powerful principal: we are opening chrome:// web page,
    // which will need lots of permission.
    var securityManager = Cc['@mozilla.org/scriptsecuritymanager;1']
                          .getService(Ci.nsIScriptSecurityManager);
    var resourcePrincipal = securityManager.getSystemPrincipal();
    aRequest.owner = resourcePrincipal;
    channel.asyncOpen(proxy, aContext);
  },

  // nsIRequestObserver::onStopRequest
  onStopRequest: function(aRequest, aContext, aStatusCode) {
    // Do nothing.
  }
};

// properties required for XPCOM registration:
function copyProperties(obj, template) {
  for (var prop in template) {
    obj[prop] = template[prop];
  }
}

function ShumwayStreamConverter() {}
ShumwayStreamConverter.prototype = new ShumwayStreamConverterBase();
copyProperties(ShumwayStreamConverter.prototype, {
  classID: Components.ID('{4c6030f7-e20a-264f-5b0e-ada3a9e97384}'),
  classDescription: 'Shumway Content Converter Component',
  contractID: '@mozilla.org/streamconv;1?from=application/x-shockwave-flash&to=*/*'
});

function ShumwayStreamOverlayConverter() {}
ShumwayStreamOverlayConverter.prototype = new ShumwayStreamConverterBase();
copyProperties(ShumwayStreamOverlayConverter.prototype, {
  classID: Components.ID('{4c6030f7-e20a-264f-5f9b-ada3a9e97384}'),
  classDescription: 'Shumway PlayPreview Component',
  contractID: '@mozilla.org/streamconv;1?from=application/x-moz-playpreview&to=*/*'
});
ShumwayStreamOverlayConverter.prototype.getUrlHint = function (requestUrl) {
  return '';
};
