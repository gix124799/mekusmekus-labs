$(document).ready(function () {
    var socket = io.connect({
        path: '/pppoe',
        transports: ['websocket', 'polling']
    });
    socket.emit('get-info', function (info) {
        var cinfo = $('#client-info tbody');
        if (info.active) {
            cinfo.append('<tr><td><label>Subscription:</label></td><td><label>' + ((info.active.expired) ? 'Expired' : 'Active') + '</label></td></tr>');
        }
        cinfo.append('<tr><td><label>Expiration:</label></td><td><label>' + date.format(new Date(info.info.expiration), 'YYYY-MM-DD HH:mm:ss') + '</label></td></tr>');
        cinfo.append('<tr><td><label>Address:</label></td><td><label>' + info.active.remoteIP + '</label></td></tr>');
        cinfo.append('<tr><td><label>MAC:</label></td><td><label>' + info.active.mac + '</label></td></tr>');
        cinfo.append('<tr><td><label>Uptime:</label></td><td><label>' + decToTime(info.active.uptime) + '</label></td></tr>');
		cinfo.append('<tr><td><label>BandWidth:</label></td><td><label>' + info.info.download + '↓/' + info.info.upload +'↑</label></td></tr>');
    });
    function decToTime(sec) {
        sec = sec / 60;
        const Year = sec / 518400;
        let YW = Math.floor(Year); //final Year;
        const YF = Year - YW;
        const Month = YF * 12;
        let MW = Math.floor(Month); //final Month;
        const MF = Month - MW;
        const Day = MF * 30;
        let DW = Math.floor(Day); //final Day
        const DF = Day - DW;
        const Hour = DF * 24;
        let HW = Math.floor(Hour); //final Hour
        const HF = Hour - HW;
        const Minute = HF * 60;
        let MSW = Math.floor(Minute); //final Minute
        const SF = Minute - MSW;
        const Seconds = SF * 60;
        let SSW = Math.round(Seconds);
        if (SSW == 60) {
            SSW = 0;
            MSW = MSW + 1;
        }
        if (YW > 0) {
            YW = YW + 'y ';
        } else {
            YW = '';
        }
        if (MW > 0) {
            MW = MW + 'm ';
        } else {
            MW = '';
        }
        if (DW > 0) {
            DW = DW + 'd ';
        } else {
            DW = '';
        }
        if (HW < 10) {
            HW = '0' + HW;
        }
        if (MSW < 10) {
            MSW = '0' + MSW;
        }
        if (SSW < 10) {
            SSW = '0' + SSW;
        }
        return (YW + MW + DW + HW + ":" + MSW + ":" + SSW);
    }
});
