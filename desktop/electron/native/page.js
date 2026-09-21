function run(argv){
 var id=argv[0],source=argv[1],target=JSON.parse(argv[2]||'{}');
 if(['com.apple.Safari','com.google.Chrome','com.microsoft.edgemac','com.brave.Browser'].indexOf(id)<0)throw new Error('UNSUPPORTED');
 var browser=Application(id);
 if(!browser.running())return JSON.stringify({status:'not_running'});
 var windows=browser.windows();
 if(windows.length===0)return JSON.stringify({status:'no_window'});
 var tab=null;
 if(target.windowId!==undefined){
  for(var wi=0;wi<windows.length;wi++){
   if(String(windows[wi].id())!==String(target.windowId))continue;
   var tabs=windows[wi].tabs();
   if(id==='com.apple.Safari'){
    var index=Number(target.tabId);
    if(index>=0&&index<tabs.length&&Number.isInteger(index)){
     var candidate=tabs[index];
     if(!target.title||String(candidate.name()).slice(0,500)===target.title)tab=candidate;
    }
   }else{
    for(var ti=0;ti<tabs.length;ti++)if(String(tabs[ti].id())===String(target.tabId)){tab=tabs[ti];break;}
   }
  }
  if(!tab)return JSON.stringify({status:'stale_tab'});
 }else tab=id==='com.apple.Safari'?windows[0].currentTab():windows[0].activeTab();
 if(!/^https?:\/\//i.test(String(tab.url())))return JSON.stringify({status:'unsupported'});
 try{return id==='com.apple.Safari'?browser.doJavaScript(source,{in:tab}):tab.execute({javascript:source});}
 catch(error){
  var message=String(error);
  return JSON.stringify({status:Number(error.errorNumber)===-1743?'permission_required':/JavaScript|javascript|脚本/.test(message)?'javascript_permission_required':'read_failed'});
 }
}
