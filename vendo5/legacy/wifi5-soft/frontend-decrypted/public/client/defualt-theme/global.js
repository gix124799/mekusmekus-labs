var defaultTheme = true;
var graph = {
    yaxis: {
        min: 0,
        color: "#000",
        font: {
            color: '#a3a3a3'
        }
    },
    xaxis: {
        color: "#000",
        show: true,
    },
    colors: ["#0000ff20", "#ff000020"],
    grid: {
        color: "#a3a3a3",
        borderWidth: 0,
        backgroundColor: 'transparent'
    },
    tooltip: true,
    responsive: true,
    lines: {
        show: true,
        fill: true
    },
    legend: {
        backgroundOpacity: 0,
    }
};
var buttoncard = $('<div class="col-lg-4 grid-margin stretch-card"><div class="card"><div class="card-body" style="padding: 10px; font-size: 15px;" ><div id="client-more-btn" class="bg-gray-dark row" style="margin: 0px; display: flex; gap: 5px;" ></div></div></div></div>');
var creditcodebtn = $('<div style="flex: 1 0 125px"><button type="button" class="btn btn-outline-danger btn-icon-text" style="width: 100%; display: block; white-space: nowrap;">Credit Code<i class="mdi mdi-credit-card btn-icon-append"></i></button></div>');
var genvoucherbtn = $('<div style="flex: 1 0 125px"><button type="button" class="btn btn-outline-danger btn-icon-text" style="width: 100%; display: block; white-space: nowrap;">Gen Voucher<i class="mdi mdi-barcode-scan btn-icon-append"></i></button></div>');
var buyloadbtn = $('<div style="flex: 1 0 125px"><a id="open-eload" class="btn btn-outline-info btn-icon-text" style="width: 100%; display: block; white-space: nowrap;">Buy Load<i class="mdi mdi-ticket btn-icon-append"></i></a></div>');
var moviesbtn = $('<div style="flex: 1 0 125px"><a type="button" href="?page=media" class="btn btn-outline-info btn-icon-text" style="width: 100%; display: block; white-space: nowrap;">Movies<i class="mdi mdi-movie btn-icon-append"></i></a></div>');
var redeembtn = $('<div style="flex: 1 0 125px"><button type="button" class="btn btn-outline-info btn-icon-text" style="width: 100%; display: block; white-space: nowrap;">Redeem</button></div>');
var extendvvoucher = $('<div style="flex: 1 0 125px"><button type="button" class="btn btn-outline-warning btn-icon-text" style="width: 100%; display: block; white-space: nowrap; letter-spacing: -1px;">Extend-Via Voucher</button></div>');
var banner = $('<div class="col-lg-12 grid-margin stretch-card"><div class="card"><div class="card-body" style="padding: 0px !important;" ><div class="banner" id="banner"></div></div></div></div>');
var graphMonitor = $('<div class="col-lg-12 grid-margin stretch-card"><div class="card"><div class="card-body" style="padding: 10px;" ><h4 class="card-title" style="margin-bottom: 2px;" >Bandwidth Monitor</h4><div id="graph" class="bg-gray-dark" style="width: 100%; min-width: 50px;  min-height: 130px; font-size: 14px;" ></div><div id="total-rx-tx" style="margin-top: 5px; font-size: 13px; text-align: right; display: flex; justify-content: flex-end;"></div></div></div></div>');
var clientstatus = $('<div class="card" style="min-height: 86px; margin-bottom: 10px;"><h4 class="card-title" id="title-status" style="display: flex; border-bottom: 1px solid; padding: 5px; margin: 5px 10px;"></h4><div class="card-body" style="display: flex; padding: 16px 20px; justify-content: space-around;"><div style="margin-right: 20px; width: 65%; display: grid; justify-content: center; padding-left: 15px;"><div class="row" style="align-content: flex-end;"><div class="d-flex align-items-center align-self-start"><h3 class="mb-0 text-success" id="client-duration"></h3></div></div><h6 class="text-muted font-weight-normal">Current Duration</h6>  <button type="button" id="free-t" class="btn btn-outline-warning btn-fw" style="display: none; min-width: 100px; text-decoration: underline;" >Free Time</button> <div id="voucher-box"><div class="row"><div class="d-flex align-items-center align-self-start"><h4 class="mb-0 text-success" id="client-voucher"></h4></div></div><h6 class="text-muted font-weight-normal">Voucher</h6></div>   </div><div style="display: grid; align-content: center;"><button id="loginout" type="button" class="btn btn-outline-warning btn-icon-text" style="font-size: 18px; display: block; white-space: nowrap; height: 45px;">Connect<i class="mdi mdi-lan-connect btn-icon-append" style="position: absolute; right: 26px;"></i></button><button id="v-ext" type="button" class="btn btn-outline-info btn-icon-text" style="margin-top: 10px; font-size: 18px; display: block; white-space: nowrap; height: 45px;" >Extend<i class="mdi mdi mdi-barcode btn-icon-append" style="position: absolute; right: 26px;"></i></button><div style="display: flex; flex-direction: column; font-size: 12px; align-items: center; margin-top: 3px; color: #6e6e85;"><div>Reserve Duration</div><div id="reserve-dur">00:00:00</div></div></div></div></div>');
var creditbox = $('<div class="card" style="min-height: 86px;"><div class="card-body" style="display: flex; padding: 10px 20px; justify-content: space-around;"><div style="margin-right: 20px; width: 75%; display: grid; justify-content: center; padding-left: 15px;"><div class="row" style="align-content: flex-end;"><div class="d-flex align-items-center align-self-start"><h3 class="mb-0 text-info" id="client-credit"></h3></div></div><h6 id="points-d" class="text-muted font-weight-normal" style="margin-left: -10px; margin-top: 5px; font-size: 14px;"></h6> <div id="progress"></div> <div id="select-box"><div class="row" style="justify-content: center;" ><div class="d-flex align-items-center align-self-start"><button class="btn btn-outline-success dropdown-toggle" type="button" id="select-box-dropdown" style="min-width: 115px;" data-toggle="dropdown" aria-haspopup="true" aria-expanded="false" disabled></button><div id="select-dropdown-options" style="max-height: 500px; overflow: auto;" class="dropdown-menu" aria-labelledby="select-box-dropdown"></div></div></div><h6 id="select-box-info" class="text-muted font-weight-normal" style="text-align: center; display: flex; margin-top: 5px;" >Select Box</h6></div>  </div><div id="insert-btn-parent" style="display: grid; align-items: center;"><button id="client-insert-coin" class="btn btn-outline-warning btn-icon-text" style="height: auto;"><i class="mdi mdi-coin btn-icon-prepend mdi-48px"></i><span id="insert1" class="d-inline-block text-left blink" style="margin: auto; font-size: 18px; font-weight: bold;">INSERT COIN</span></button></div></div></div>');
var clientinfocard = $('<div class="col-lg-4 grid-margin stretch-card" id="client-info-box"><div class="card"><div class="card-body" style="padding: 10px; font-size: 15px;" ><h4 class="card-title" style="border-bottom: 1px solid;" >Client Info</h4><div id="client-info-card" class="bg-gray-dark"></div></div></div></div>');
var clientinfochild = $('<div style="display: flex;"><div class="text-success" style="margin-right: 10px;"></div></div>');
var ratecard = $('<div id="rates-card" class="col-lg-4 grid-margin stretch-card"><div class="card"><div class="card-body"><h4 class="card-title" style="margin-bottom: 5px;"></h4><div class="table-responsive"><table class="table"><thead><tr><th>Amount</th><th>Time</th></tr></thead><tbody id="rates-tbody"></tbody></table></div></div></div></div>');
var insertboxoption = $('<h6 style="border-bottom: 1px solid #2c2e33;" class="dropdown-header"></h6>');
var _genvoucherbtn = $('<button style="white-space: nowrap; width: 100%; margin: 0px 5px;" type="button" class="btn btn-link" style="text-decoration: underline; height: auto; white-space: nowrap;">Get Voucher</button>');
var _gotoeload = $('<a style="white-space: nowrap; width: 100%; margin: 0px 5px;" class="btn btn-link" style="height: 27px; text-decoration: underline; height: auto; white-space: nowrap;">Buy Eload</a>');
var _close = $('<button style="white-space: nowrap; width: 100%; margin: 0px 5px;" type="button" data-dismiss="modal" class="btn btn-outline-danger" style="height: 27px;">Close</button>');
var _yes = $('<button style="white-space: nowrap; width: 100%; margin: 0px 5px;" type="button" class="btn btn-outline-success" style="height: 27px; margin-left: 5px;"></button>');
var _infhtml = $('<div style="color: yellow; font-size: 16px;"></div>');
var _footer = $('<div style="display: flex; margin-top: 20px; justify-content: space-evenly; align-items: flex-end; width: 100%;"></div>');
var gcashin = $('<div style="flex: 1 0 125px"><button type="button" class="btn btn-outline-warning btn-icon-text" style="width: 100%; display: block; white-space: nowrap; letter-spacing: -1px;"><span class="text-primary">GCASH</span>/<span class="text-success" style="margin-right: 5px;">MAYA</span> CASH-IN</button></div>');