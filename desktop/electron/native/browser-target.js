// Use ScriptingBridge's PID address: bundle IDs do not distinguish concurrent instances.
function browserTarget(id, pid) {
  if (pid === undefined || pid === null) return Application(id);
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("INVALID_PROCESS");
  ObjC.import("AppKit");
  ObjC.import("ScriptingBridge");
  var process =
    $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);
  if (
    !process ||
    process.isNil() ||
    process.terminated ||
    ObjC.unwrap(process.bundleIdentifier) !== id
  )
    return {
      running: function () {
        return false;
      },
    };
  var app = $.SBApplication.applicationWithProcessIdentifier(pid);
  if (!app || app.isNil()) throw new Error("UNSUPPORTED_PROCESS");
  var failure = null;
  ObjC.registerSubclass({
    name: "OtterBrowserEventDelegate",
    methods: {
      "eventDidFail:withError:": {
        types: ["id", ["id", "id"]],
        implementation: function (event, error) {
          failure = {
            code: Number(error.code),
            message: ObjC.unwrap(error.localizedDescription),
          };
          return null;
        },
      },
    },
  });
  var delegate = $.OtterBrowserEventDelegate.alloc.init;
  app.delegate = delegate;
  function check(value) {
    if (failure) {
      var error = new Error(failure.message + " (" + failure.code + ")");
      error.errorNumber = failure.code;
      throw error;
    }
    return value;
  }
  function get(object, key) {
    return check(object.valueForKey(key));
  }
  function scalar(object, key) {
    return ObjC.unwrap(get(object, key));
  }
  function tab(raw) {
    return {
      raw: raw,
      id: function () {
        return scalar(raw, "id");
      },
      title: function () {
        return scalar(raw, "title");
      },
      name: function () {
        return scalar(raw, "name");
      },
      index: function () {
        return scalar(raw, "index");
      },
      url: function () {
        return scalar(raw, "URL");
      },
      execute: function (args) {
        return ObjC.unwrap(
          check(
            raw.performSelectorWithObject(
              "executeJavascript:",
              $(args.javascript),
            ),
          ),
        );
      },
    };
  }
  function list(raw, key, wrap) {
    var values = get(raw, key),
      result = [];
    var count = Number(check(values.count));
    for (var i = 0; i < count; i++) result.push(wrap(values.objectAtIndex(i)));
    return result;
  }
  return {
    running: function () {
      return !!app.running;
    },
    windows: function () {
      return list(app, "windows", function (raw) {
        return {
          id: function () {
            return scalar(raw, "id");
          },
          tabs: function () {
            return list(raw, "tabs", tab);
          },
          activeTab: function () {
            return tab(get(raw, "activeTab"));
          },
          currentTab: function () {
            return tab(get(raw, "currentTab"));
          },
        };
      });
    },
    doJavaScript: function (source, args) {
      return ObjC.unwrap(
        check(
          app.performSelectorWithObjectWithObject(
            "doJavaScript:in:",
            $(source),
            args.in.raw,
          ),
        ),
      );
    },
  };
}
