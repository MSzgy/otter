function run(argv){
 var id=argv[0],source=argv[1];
 if(['com.apple.Safari','com.google.Chrome','com.microsoft.edgemac','com.brave.Browser'].indexOf(id)<0)throw new Error('UNSUPPORTED');
 var browser=Application(id);
 if(!browser.running()||browser.windows.length===0)return JSON.stringify({status:'empty'});
 var tab=id==='com.apple.Safari'?browser.windows[0].currentTab:browser.windows[0].activeTab;
 if(!/^https?:\/\//i.test(String(tab.url())))return JSON.stringify({status:'unsupported'});
 return id==='com.apple.Safari'?browser.doJavaScript(source,{in:tab}):tab.execute({javascript:source});
}
