(function(window, document, red5pro) {
  'use strict';

  var serverSettings = (function() {
    var settings = sessionStorage.getItem('r5proServerSettings');
    try {
      return JSON.parse(settings);
    }
    catch (e) {
      console.error('Could not read server settings from sessionstorage: ' + e.message);
    }
    return {};
  })();

  var configuration = (function () {
    var conf = sessionStorage.getItem('r5proTestBed');
    try {
      return JSON.parse(conf);
    }
    catch (e) {
      console.error('Could not read testbed configuration from sessionstorage: ' + e.message);
    }
    return {}
  })();

  red5pro.setLogLevel(configuration.verboseLogging ? red5pro.LogLevels.TRACE : red5pro.LogLevels.WARN);

  var updateStatusFromEvent = window.red5proHandlePublisherEvent; // defined in src/template/partial/status-field-publisher.hbs
  var targetPublisher;
  var targetView;
  var streamTitle = document.getElementById('stream-title');
  var statisticsField = document.getElementById('statistics-field');
  var addressField = document.getElementById('address-field');
  var protocol = serverSettings.protocol;
  var isSecure = protocol == 'https';
  function getSocketLocationFromProtocol () {
    return !isSecure
      ? {protocol: 'ws', port: serverSettings.wsport}
      : {protocol: 'wss', port: serverSettings.wssport};
  }

  var defaultConfiguration = {
    protocol: getSocketLocationFromProtocol().protocol,
    port: getSocketLocationFromProtocol().port,
    app: 'live'
  };

  function displayServerAddress (serverAddress) {
    addressField.innerText = 'Origin Address: ' + serverAddress;
  }

  function onBitrateUpdate (bitrate, packetsSent) {
    statisticsField.innerText = 'Bitrate: ' + Math.floor(bitrate) + '. Packets Sent: ' + packetsSent + '.';
  }

  function onPublisherEvent (event) {
    console.log('[Red5ProPublisher] ' + event.type + '.');
    updateStatusFromEvent(event);
  }
  function onPublishFail (message) {
    console.error('[Red5ProPublisher] Publish Error :: ' + message);
  }
  function onPublishSuccess (publisher) {
    console.log('[Red5ProPublisher] Publish Complete.');
    try {
      window.trackBitrate(publisher.getPeerConnection(), onBitrateUpdate);
    }
    catch (e) {
      //
    }
  }
  function onUnpublishFail (message) {
    console.error('[Red5ProPublisher] Unpublish Error :: ' + message);
  }
  function onUnpublishSuccess () {
    console.log('[Red5ProPublisher] Unpublish Complete.');
  }

  function requestOrigin (configuration) {
    var host = configuration.host;
    var app = configuration.app;
    var streamName = configuration.stream1;
    var port = serverSettings.httpport;
    var portURI = (port.length > 0 ? ':' + port : '');
    var baseUrl = isSecure ? protocol + '://' + host : protocol + '://' + host + portURI;
    var apiVersion = configuration.streamManagerAPI || '2.0';
    var url = baseUrl + '/streammanager/api/' + apiVersion + '/event/' + app + '/' + streamName + '?action=broadcast';
      return new Promise(function (resolve, reject) {
        fetch(url)
          .then(function (res) {
            if (res.headers.get("content-type") &&
              res.headers.get("content-type").toLowerCase().indexOf("application/json") >= 0) {
                return res.json();
            }
            else {
              throw new TypeError('Could not properly parse response.');
            }
          })
          .then(function (json) {
            resolve(json.serverAddress);
          })
          .catch(function (error) {
            var jsonError = typeof error === 'string' ? error : JSON.stringify(error, null, 2)
            console.error('[PublisherStreamManagerTest] :: Error - Could not request Origin IP from Stream Manager. ' + jsonError)
            reject(error)
          });
    });
  }

  function getUserMediaConfiguration () {
    return {
      audio: configuration.useAudio ? configuration.userMedia.audio : false,
      video: configuration.useVideo ? configuration.userMedia.video : false,
      frameRate: configuration.frameRate
    };
  }

  function determinePublisher () {

    var config = Object.assign({},
                   configuration,
                   getUserMediaConfiguration());
    var rtcConfig = Object.assign({}, config, {
                      protocol: getSocketLocationFromProtocol().protocol,
                      port: getSocketLocationFromProtocol().port,
                      streamName: config.stream1,
                      streamType: 'webrtc'
                   });
    var rtmpConfig = Object.assign({}, config, {
                      protocol: 'rtmp',
                      port: serverSettings.rtmpport,
                      streamName: config.stream1,
                      width: config.cameraWidth,
                      height: config.cameraHeight,
                      swf: '../../lib/red5pro/red5pro-publisher.swf',
                      swfobjectURL: '../../lib/swfobject/swfobject.js',
                      productInstallURL: '../../lib/swfobject/playerProductInstall.swf'
                   });
    var publishOrder = config.publisherFailoverOrder.split(',').map(function (item) {
      return item.trim()
    });

    return new Promise(function (resolve, reject) {

      var publisher = new red5pro.Red5ProPublisher();
      publisher.on('*', onPublisherEvent);

      publisher.setPublishOrder(publishOrder)
        .init({
          rtc: rtcConfig,
          rtmp: rtmpConfig
        })
        .then(function (selectedPublisher) {
          var type = selectedPublisher ? selectedPublisher.getType() : undefined;
          var requiresPreview = type.toLowerCase() === publisher.publishTypes.RTC;
          publisher.off('*', onPublisherEvent);
          resolve({
            publisher: selectedPublisher,
            requiresPreview: requiresPreview
          });
        })
        .catch(function (error) {
          reject(error);
        });

    });
  }

  function preview (publisher, requiresGUM) {
    var gUM = getUserMediaConfiguration;
    return new Promise(function (resolve, reject) {

      var elementId = 'red5pro-publisher-video';
      var view = new red5pro.PublisherView(elementId);
      var nav = navigator.mediaDevice || navigator;

      view.attachPublisher(publisher);

      if (requiresGUM) {
        console.log('[Red5ProPublisher] gUM:: ' + JSON.stringify(gUM(), null, 2));
        nav.getUserMedia(gUM(), function (media) {

          // Upon access of user media,
          // 1. Attach the stream to the publisher.
          // 2. Show the stream as preview in view instance.
          publisher.attachStream(media);
          view.preview(media, true);

          targetPublisher = publisher;
          targetView = view;
          resolve(targetPublisher);

        }, function(error) {

          onPublishFail('Error - ' + error);
          reject(error);

        })
      }
      else {
        targetPublisher = publisher;
        targetView = view;
        resolve(targetPublisher);
      }
    });
  }

  function publish () {
    var publisher = targetPublisher;
    var config = Object.assign({},
                    configuration,
                    defaultConfiguration,
                    getUserMediaConfiguration());
    config.streamName = config.stream1;
    streamTitle.innerText = config.streamName;
    console.log('[Red5ProPublisher] config:: ' + JSON.stringify(config, null, 2));

    // Initialize
    publisher.publish()
      .then(function () {
        onPublishSuccess(publisher);
      })
      .catch(function (error) {
        // A fault occurred while trying to initialize and publish the stream.
        var jsonError = typeof error === 'string' ? error : JSON.stringify(error, null, 2);
        onPublishFail('Error - ' + jsonError);
      });
  }

  function unpublish () {
    return new Promise(function (resolve, reject) {
      var view = targetView;
      var publisher = targetPublisher;
      if (publisher) {
        publisher.unpublish()
          .then(function () {
            view.view.src = '';
            publisher.setView(undefined);
            publisher.off('*', onPublisherEvent);
            onUnpublishSuccess();
            resolve();
          })
          .catch(function (error) {
            var jsonError = typeof error === 'string' ? error : JSON.stringify(error, null, 2);
            onUnpublishFail('Unmount Error ' + jsonError);
            reject(error);
          });
      }
      else {
        onUnpublishSuccess();
        resolve();
      }
    });
  }

  // Kick off.
  requestOrigin(configuration)
    .then(function (serverAddress) {
      displayServerAddress(serverAddress);
      configuration.host = serverAddress;
      determinePublisher()
        .then(function (payload) {
          var requiresPreview = payload.requiresPreview;
          var publisher = payload.publisher;
          publisher.on('*', onPublisherEvent);
          return preview(publisher, requiresPreview);
        })
        .then(function (publisher) {
          publish(publisher, configuration.stream1);
        })
        .catch(function (error) {
          console.error('[Red5ProPublisher] :: Error in publishing - ' + error);
         });
    })
    .catch(function (error) {
      console.error('[Red5ProPublisher] :: Error in access of Origin IP: ' + error);
      updateStatusFromEvent({
        type: red5pro.PublisherEventTypes.CONNECT_FAILURE
      });
    });

  window.addEventListener('beforeunload', function() {
    function clearRefs () {
      targetPublisher.off('*', onPublisherEvent);
      targetView = targetPublisher = undefined;
    }
    unpublish().then(clearRefs).catch(clearRefs);
    window.untrackBitrate();
  });

})(this, document, window.red5prosdk);
