// Only an allowlisted browser's active tab is queried. Never evaluate page JavaScript.
function run(argv) {
  var ids=['com.apple.Safari','com.google.Chrome','com.microsoft.edgemac','com.brave.Browser'];
  var id=argv[0];
  if(ids.indexOf(id)<0)throw new Error('UNSUPPORTED');
  var browser=Application(id);
  if(!browser.running())return JSON.stringify({status:'not_running'});
  if(browser.windows.length===0)return JSON.stringify({status:'no_tab'});
  var tab=id==='com.apple.Safari'?browser.windows[0].currentTab:browser.windows[0].activeTab;
  return JSON.stringify({status:'ready',title:String(id==='com.apple.Safari'?tab.name():tab.title()),url:String(tab.url())});
}
