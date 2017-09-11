define(function(require, exports, module) {
    main.consumes = [
        "api", "c9", "collab.workspace", "commands", "dialog.alert",
        "dialog.confirm", "dialog.error", "dialog.notification", "fs", "http",
        "layout", "menus", "Plugin", "preferences", "proc", "settings",
        "tabManager", "terminal", "ui"
    ];
    main.provides = ["harvard.cs50.info"];
    return main;

    function main(options, imports, register) {
        var Plugin = imports.Plugin;

        var alert = imports["dialog.alert"].show;
        var api = imports.api;
        var c9 = imports.c9;
        var commands = imports.commands;
        var confirm = imports["dialog.confirm"].show;
        var fs = imports.fs;
        var http = imports.http;
        var layout = imports.layout;
        var menus = imports.menus;
        var notify = imports["dialog.notification"].show;
        var prefs = imports.preferences;
        var proc = imports.proc;
        var settings = imports.settings;
        var showError = imports["dialog.error"].show;
        var tabs = imports.tabManager;
        var terminal = imports.terminal;
        var ui = imports.ui;
        var workspace = imports["collab.workspace"];

        var _ = require("lodash");
        var join = require("path").join;

        /***** Initialization *****/

        var plugin = new Plugin("CS50", main.consumes);
        var emit = plugin.getEmitter();

        var DEFAULT_REFRESH = 30;   // default refresh rate
        var delay;                  // current refresh rate
        var fetching;               // are we fetching data
        var stats = null;           // last recorded stats
        var timer = null;           // javascript interval ID
        var domain = null;          // current domain
        var BIN = "~/.cs50/bin/";
        var presenting = false;
        var version = {};

        // info50 script
        var info50 = {
            name: ".info50",
            content: require("text!./bin/info50"),
            revision: 3,
            revision_setting: "project/cs50/info/@info_revision"
        };

        // update50 script
        var update50 = {
            name: "update50",
            content: require("text!./bin/update50"),
            revision: 3,
            revision_setting: "project/cs50/info/@update_revision"
        };

        function load() {
            // load plugins CSS
            ui.insertCss(require("text!./style.css"), options.staticPrefix, plugin);

            fetching = false;

            // notify the instance of the domain the IDE is loaded on
            domain = window.location.hostname;

            // we only want the domain; e.g., "cs50.io" from "ide.cs50.io"
            if (domain.substring(0, 3) === "ide")
                domain = domain.substring(4);

            // set default values
            settings.on("read", function() {
                settings.setDefaults("user/cs50/info", [
                    ["refreshRate", DEFAULT_REFRESH],
                ]);

                settings.setDefaults("project/cs50/info", [
                    ["public", false]
                ]);
            });

            // watch for settings change and update accordingly
            settings.on("user/cs50/info/@refreshRate", function(rate) {
                if (delay !== rate) {
                    // validate new rate, overwriting bad value if necessary
                    if (isNaN(rate) || rate < 1) {
                        delay = DEFAULT_REFRESH;
                        settings.set("user/cs50/info/@refreshRate", delay);
                    }
                    else {
                        delay = rate;
                    }

                    // update stats and timer interval
                    updateStats();
                    stopTimer();
                    startTimer();
                }
            }, plugin);

            // fetch setting information
            delay = settings.getNumber("user/cs50/info/@refreshRate");

            // create version button
            version.button = new ui.button({
                caption: "n/a",
                class: "cs50-version-btn",
                enabled: false,
                skin: "c9-menu-btn",
                width: 50
            });

            // fetch latest ide50.deb version
            fetchLatestVersion();

            // place version button
            ui.insertByIndex(layout.findParent({
                name: "preferences"
            }), version.button, 500, plugin);

            // cache whether presentation is on initially
            presenting = settings.getBool("user/cs50/presentation/@presenting");

            // set visibility of version number initially
            toggleVersion(!presenting);

            // handle toggling presentation
            settings.on("user/cs50/presentation/@presenting", function(newVal) {
                 // cache setting
                presenting = newVal;

                // toggle visibility of version number
                toggleVersion(!presenting);
            }, plugin);

            // Add preference pane
            prefs.add({
               "CS50" : {
                    position: 5,
                    "IDE Information" : {
                        position: 10,
                        "Information refresh rate (in seconds)" : {
                            type: "spinner",
                            path: "user/cs50/info/@refreshRate",
                            min: 1,
                            max: 200,
                            position: 200
                        }
                    }
                }
            }, plugin);

            // creates new divider and places it after 'About Cloud9'
            var div = new ui.divider();
            menus.addItemByPath("Cloud9/div", div, 100, plugin);

            // creates the "Web Server" item
            var webServer = new ui.item({
                id: "websserver",
                caption: "Web Server",
                onclick: displayWebServer
            });

            // places it in CS50 IDE tab
            menus.addItemByPath("Cloud9/Web Server", webServer, 102, plugin);

            // hold fetching stats
            fetching = true;

            // write info50
            writeScript(info50, function(err) {
                fetching = false;
                if (err)
                    return console.log(err);

                // fetch data
                updateStats();
                startTimer();
            });

            // write update50
            writeScript(update50);

            // write update50 on PATH temporarily
            update50.dir = "~/bin";
            writeScript(update50);

            // add command to restart workspace online or instruct user to restart offline
            commands.addCommand({
                name: "complete_update",
                hint: "Restarts workspace after confirmation",
                exec: function() {

                    if (c9.hosted) {

                        // make API call to restart container online
                        confirm(
                            "Update Almost Complete",
                            "Restart your workspace to complete update?",
                            "Any files you have open will stay open.",

                            // OK
                            function() {
                                commands.exec("restartc9vm");
                                window.location.reload();
                            },

                            // Cancel
                            function() {}
                        );
                    }
                    else {

                        // user has to restart container manually offline
                        alert(
                            "Update almost complete",
                            'Run <code style="font: 14px monospace; padding: 0 5px">docker restart ide50</code> in your ' +
                                "computer's terminal or Docker QuickStart " +
                                "Terminal to complete the update!",
                            "",
                            function() {},
                            { isHTML: true }
                        );
                    }
                }
            }, plugin);
        }

        /**
         * Opens the web server in a new window/tab
         */
        function displayWebServer() {
            if(!stats || !stats.hasOwnProperty("host")) {
                // rewrite .info50 on reload
                settings.set(info50.revision_setting, 0);
                return showError("Error opening workspace domain. Try reloading the IDE!");
            }

            window.open(stats.host);
        }

        /**
         * Fetches latest version number of ide50.deb daily
         */
        function fetchLatestVersion() {
            if (!version.button) {
                return;
            }

            // delay until current version is fetched
            else if (!_.isNumber(version.current)) {
                // avoid registering more than once
                plugin.off("statsUpdate", fetchLatestVersion);
                plugin.once("statsUpdate", fetchLatestVersion);
                return;
            }

            // fetch daily
            if (version.interval)
                clearInterval(version.interval);

            version.interval = setInterval(fetchLatestVersion, 86400000);

            // use the cahce if possible
            version.latest = settings.getNumber("project/cs50/info/@latestVersion") || 0;
            if (version.latest > version.current)
                return showUpdate();

            // query the mirror
            http.request(
                "https://mirror.cs50.net/ide50/2015/dists/trusty/main/binary-amd64/Packages",
                { contentType: "text/plain" },
                function(err, data) {
                    if (err)
                        return console.log(err);

                    // find latest version
                    var matches = /Package:\s*ide50\s*\nVersion:\s*(\d+)/m.exec(data);
                    if (!matches)
                        return;

                    // parse fetched version
                    var fetchedVersion = _.parseInt(matches[1]);

                    // update latest version and cache when should
                    if (fetchedVersion > version.latest) {
                        // update latest version
                        version.latest = fetchedVersion;

                        // cache latest version
                        settings.set("project/cs50/info/@latestVersion", version.latest);
                    }

                    // show update notification if should
                    showUpdate(version.latest > version.current);
                }
            );
        }

        /**
         * Shows or hides update notification
         *
         * @param [boolean] show whether to show or hide update notification
         */
        function showUpdate(show) {
            if (show === false && _.isFunction(notify.hide)) {
                notify.hide();
                notify.hide = null;
                return;
            }
            else if (show !== false && !notify.hide) {
                notify.hide = notify(
                    '<div class="cs50-info-update">An update is available for CS50 IDE. Run <code>update50</code> in a terminal window.</div>',
                    true
                );
            }
        }

        /**
         * Updates caption of version button and shows or hides update
         * notification when should
         */
        function updateVersionButton() {
            if (!version.button)
                return;

            // handle when current version isn't available
            if (!_.isNumber(version.current)) {
                version.button.setCaption("n/a");
                showUpdate(false);
                return;
            }

            // show or hide update notification when should
            else if (_.isNumber(version.latest)) {
                if (version.latest > version.current)
                    showUpdate();
                else
                    showUpdate(false);
            }

            // update caption
            version.button.setCaption("v" + version.current);
        }

        /**
         * Stop automatic refresh of information by disabling JS timer
         */
        function stopTimer() {
            if (timer === null)
                return;
            window.clearInterval(timer);
            timer = null;
        }

        /**
         * If not already started, begin a timer to automatically refresh data
         */
        function startTimer() {
            if (timer !== null)
                return;
            timer = window.setInterval(updateStats, delay * 1000);
        }

        /**
         * Updates the shared status (public or private).
         */
        function fetchSharedStatus() {
            api.project.get("", function(err, data) {
                if (err || workspace.myUserId != data.owner.id)
                    return;

                settings.set(
                    "project/cs50/info/@public",
                    data["visibility"] === "public" || data["appAccess"] === "public"
                );
            });
        }

        /**
         * Initiate an info refresh by calling `info50`
         */
        function updateStats(callback) {
            // respect the lock
            if (fetching)
                return;

            fetching = true;

            // check for shared state
            if (c9.hosted)
                fetchSharedStatus();

            // hash that uniquely determines this client
            var myID = workspace.myUserId;
            var myClientID = workspace.myClientId;
            var hash = myID + "-" + myClientID;

            // extra buffer time for info50
            // refer to info50 for more documentation on this
            var buffer = delay + 2;

            proc.execFile(".info50", {
                args: [domain, hash, buffer],
                cwd: BIN
            }, parseStats);
        }

        /**
         * Process output from info50 and update UI with new info
         */
        function parseStats(err, stdout, stderr) {
            // release lock
            fetching = false;

            if (err) {
                // disconnected client; don't provide error
                if (err.code === "EDISCONNECT")
                    return;

                version.current = null;
                updateVersionButton();
                return console.log(err);;
            }

            // parse the JSON returned by info50 output
            stats = JSON.parse(stdout);

            // update caption of version button
            version.current = _.parseInt(stats.version);
            if (_.isNaN(version.current))
                version.current = null;

            updateVersionButton();

            // announce stats update
            emit("statsUpdate");
        }

        /**
         * Toggles visiblity of version number. Forcibly hides version number if
         * presentation is on.
         *
         * @param {boolean} show whether to show or hide version number (has no
         * effect if true and presentation is on)
         */
        function toggleVersion(show) {
            // ensure button was initialized
            if (version.button) {
                // forcibly hide while presentation is on or set to hide only
                if (presenting || !show)
                    version.button.hide();
                else if (show)
                    version.button.show();
            }
        }

        /**
         * Writes/updates a script to BIN/options.name and chmods it 755
         *
         * @param {object} options an object with properties:
         *   - name: script name
         *   - content: script content
         *   - revision: script revision number
         *   - revision_setting: setting path for revision number
         * @param [function] callback called after script is written and
         * chmoded or if the latest revision is already installed
         */
        function writeScript(options, callback) {
            callback = callback || function() {};

            // installation path
            var path = join((options.dir || BIN), options.name);
            fs.exists(path, function(exists) {

                // fetch script revision number from settings
                var revision = settings.getNumber(options.revision_setting) || 0;

                // write script if doesn't exist or if updated
                if (!exists || revision < options.revision) {

                    // write script
                    fs.writeFile(path, options.content, function(err) {
                        if (err) {
                            showError("Failed to write " + options.name);
                            return callback(err);
                        }

                        // chmod script
                        fs.chmod(path, 755, function(err) {
                            if (err) {
                                showError("Failed to chmod " + options.name);
                                return callback(err)
                            }

                            // update revision number in settings
                            settings.set(options.revision_setting, options.revision);

                            callback();
                        });
                    });
                }
                else {
                    callback();
                }
            });
        }
        /***** Lifecycle *****/

        plugin.on("load", function() {
            load();
        });

        plugin.on("unload", function() {
            stopTimer();

            delay = 30;
            timer = null;
            fetching = false;
            stats = null;
            domain = null;
            presenting = false;
            version = {};
        });

        /***** Register and define API *****/

        /**
         * This is an example of an implementation of a plugin.
         * @singleton
         */
        plugin.freezePublicAPI({
            /**
             * @property host
             */
            get host() { return (stats && stats.hasOwnProperty("host")) ? stats.host : null; },

            /**
             * @property hasLoaded whether info50 has run at least once
             */
            get hasLoaded() { return (stats != null); },
        });

        register(null, {
            "harvard.cs50.info": plugin
        });
    }
});
