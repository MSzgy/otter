// JXA collections are callable specifiers: windows.length is NOT the window count.
function run(argv) {
  var ids=['com.apple.Safari','com.google.Chrome','com.microsoft.edgemac','com.brave.Browser'];
  var id=argv[0];
  if(ids.indexOf(id)<0)throw new Error('UNSUPPORTED');
  var browser=Application(id);
  if(!browser.running())return JSON.stringify({status:'not_running',tabs:[]});
  var windows=browser.windows(), tabs=[], current=null, truncated=false;
  for(var wi=0;wi<windows.length;wi++){
    var window=windows[wi], list=window.tabs(), active=id==='com.apple.Safari'?window.currentTab():window.activeTab();
    var windowId=String(window.id());
    for(var ti=0;ti<list.length;ti++){
      if(tabs.length>=200){truncated=true;break;}
      var tab=list[ti];
      var isActive=id==='com.apple.Safari'?Number(tab.index())===Number(active.index()):String(tab.id())===String(active.id());
      var entry={windowId:windowId,windowIndex:wi+1,tabId:id==='com.apple.Safari'?String(ti):String(tab.id()),tabIndex:ti,
        title:String(id==='com.apple.Safari'?tab.name():tab.title()).slice(0,500),url:String(tab.url()).slice(0,4096),active:isActive};
      tabs.push(entry);if(!current&&isActive)current=entry;
    }
    if(truncated)break;
  }
  current=current||tabs[0];
  return JSON.stringify({status:tabs.length?'ready':'no_tab',windowCount:windows.length,tabs:tabs,truncated:truncated,
    title:current?current.title:'',url:current?current.url:''});
}
