/* Applies a forced theme (Settings › Display) before first paint. Loaded in <head>; tiny on purpose. */
(function(){
  try{
    var t=(JSON.parse(localStorage.getItem("prefs")||"{}")||{}).theme;
    if(t!=="light" && t!=="dark") return;
    document.documentElement.setAttribute("data-theme", t);
    var c = t==="light" ? "#F7F8FA" : "#0B0D12";
    var m=document.querySelectorAll('meta[name="theme-color"]');
    for(var i=0;i<m.length;i++) m[i].setAttribute("content", c);
  }catch(e){}
})();
