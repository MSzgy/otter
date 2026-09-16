// JXA, executed by macOS osascript. AppKit access does not inspect window contents.
ObjC.import('AppKit');
function item(app) {
  if (!app || app.isNil()) return null;
  return {name:ObjC.unwrap(app.localizedName)||'Unknown',bundleId:ObjC.unwrap(app.bundleIdentifier)||'',pid:Number(app.processIdentifier)};
}
function run() {
  var workspace=$.NSWorkspace.sharedWorkspace;
  var running=workspace.runningApplications;
  var apps=[];
  for(var i=0;i<running.count;i++){
    var app=running.objectAtIndex(i);
    if(Number(app.activationPolicy)===0) apps.push(item(app));
  }
  return JSON.stringify({front:item(workspace.frontmostApplication),apps:apps});
}
