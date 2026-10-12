// Added to every portal page: remembers this phone's resume code in the browser and, when the phone comes back
// with a new random MAC (another vendo's SSID, "Forget network"), hands it to the vendo to get the time back.
// shortcut: where the captive-portal popup keeps no storage (often iOS) this does nothing; the Logs-page code is the fallback.
const RESUME_SCRIPT = `<script>(function(){
var K='vendo5-resume-code';
function get(){try{return localStorage.getItem(K)||'';}catch(e){return '';}}
function put(c){try{if(c)localStorage.setItem(K,c);}catch(e){}}
function sync(){var x=new XMLHttpRequest();x.open('POST','/api/resume-code');x.setRequestHeader('Content-Type','application/json');
x.onload=function(){try{var r=JSON.parse(x.responseText);put(r.code);if(r.moved)location.reload();}catch(e){}};x.send(JSON.stringify({code:get()}));}
sync();setInterval(sync,30000);
})();</script>`;

module.exports = { RESUME_SCRIPT };
