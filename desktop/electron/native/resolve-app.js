ObjC.import('AppKit');
function run(argv){var url=$.NSWorkspace.sharedWorkspace.URLForApplicationWithBundleIdentifier(argv[0]);if(!url||url.isNil())return 'null';var p=ObjC.unwrap(url.path);return JSON.stringify({name:p.split('/').pop().replace(/\.app$/,''),path:p});}
