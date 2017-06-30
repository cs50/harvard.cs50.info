define(function(require, exports, module) {
    main.consumes = [
        "api", "c9", "collab.workspace", "commands", "dialog.confirm",
        "dialog.error", "dialog.notification", "fs", "http", "layout", "menus",
        "Plugin", "preferences", "proc", "settings", "tabManager", "terminal",
        "ui"
    ];
    main.provides = ["harvard.cs50.info"];
    return main;

    function main(options, imports, register) {
        var Plugin = imports.Plugin;

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

        var INFO_VER = 1;
        var UPDATE_VER = 1;

        /***** Initialization *****/

        var plugin = new Plugin("CS50", main.consumes);
        var emit = plugin.getEmitter();

        var DEFAULT_REFRESH = 30;   // default refresh rate
        var delay;                  // current refresh rate
        var fetching;               // are we fetching data
        var stats = null;           // last recorded stats
        var timer = null;           // javascript interval ID
        var domain = null;          // current domain
        var BIN = "~/bin/";         // location of .info50 script
        var presenting = false;
        var version = {};
        var VERSION_PATH = "project/cs50/info/@ver";

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

            // write update script
            var update_path = BIN + "update50";
            fs.exists(update_path, function(exists) {

                // fetch script revision number from settings
                var ver = settings.getNumber("project/cs50/info/@update_version") || 0;

                // write script if not exists or updated
                if (!exists || ver < UPDATE_VERSION) {

                    // load script contents
                    var content = require("text!./bin/update50");

                    // write script
                    fs.writeFile(update_path, content, function(err) {
                        if (err)
                            return showError("Failed to write update50");

                        // chmod script
                        fs.chmod(update_path, 755, function(err) {
                            if (err)
                                return showError("Failed to chmod update50");

                            // update revision number in settings
                            settings.set("project/cs50/info/@update_version", UPDATE_VERSION);
                        });
                    });
                }
            });

            // .info50's path
            var path = BIN + ".info50";

            // ensure .info50 exists
            fs.exists(path, function(exists) {
                // fetch version of current .info50 script
                var ver = settings.getNumber(VERSION_PATH);

                // write .info50 when should
                if (!exists || isNaN(ver) || ver < INFO_VER) {
                    // fetch contents
                    var content = require("text!./bin/info50");

                    // hold fetching stats
                    fetching = true;

                    // write .info50
                    fs.writeFile(path, content, function(err) {
                        if (err)
                            return console.error(err);

                        // make .info50 world-executable
                        fs.chmod(path, 755, function(err) {
                            if (err)
                                return console.error(err);

                            // update cached version of info50 script
                            settings.set(VERSION_PATH, INFO_VER);
                            fetching=false;

                            // fetch data
                            updateStats();

                            // always verbose, start timer
                            startTimer();
                        });
                    });
                }
                else {
                    // fetch stats
                    updateStats();

                    // always verbose, start timer
                    startTimer();
                }
            });

            // add command to restart terminal sessions after update
            commands.addCommand({
                name: "restart_terminals",
                group: "Terminal",
                hint: "Restarts all terminal sessions",
                exec: function() {

                    // find whether at least 2 terminals are open
                    var count = 0;
                    tabs.getTabs().some(function(tab) {
                        return (tab.editorType === "terminal") && (++count === 2);
                    });

                    confirm("Update almost complete",
                        "Reload CS50 IDE and restart terminal window" + (count == 2 ? "s" : "") + " to complete update?",

                        // warn based on number of terminals
                        (count === 2)
                            ? "Doing so will kill any programs that are running in open terminal windows."
                            : "",

                        // OK
                        function() {
                            // find a terminal tab
                            var term = tabs.getTabs().find(function(tab) {
                                return tab.editorType === "terminal";
                            });

                            if (!term)
                                return;

                            // focus terminal tab
                            tabs.focusTab(term);

                            // get terminal's context menu
                            terminal.getElement("mnuTerminal", function(e) {

                                // find "Restart All Terminal Sessions"
                                var rest = e.childNodes.find(function(item) {
                                    return item.command === "term_restart";
                                });

                                // click it
                                if (rest) {
                                    rest.dispatchEvent("click");
                                    window.location.reload();
                                }
                            });
                        },

                        // Cancel
                        function() {}
                    );
                }
            }, plugin);
        }

        /**
         * Opens the web server in a new window/tab
         */
        function displayWebServer() {
            if(!stats || !stats.hasOwnProperty("host")) {
                // rewrite .info50 on reload
                settings.set(VERSION_PATH, 0);
                return showError("Error opening workspace domain. Try reloading the IDE!");
            }

            window.open("//" + stats.host);
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
                    '<div class="cs50-notification">An update is available for CS50 IDE. Run <pre>update50</pre> in a terminal window.</div>',
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
