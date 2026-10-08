import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { premium as c, premiumRadius as r } from '../lib/theme';

type Coordinates = { latitude: number; longitude: number };
type RouteStop = Coordinates & { current: boolean; name: string; order: number; approximate: boolean };
export type RouteMapProps = { destination: Coordinates & { approximate?: boolean }; position: Coordinates | null; path: Coordinates[]; stops: RouteStop[] };

const LOAD_TIMEOUT_MS = 20_000;

// A self-contained MapLibre page using OpenFreeMap tiles (free, no API key). Data is pushed in
// with window.update(...) so the map keeps its zoom/pan while position and route refresh.
const buildHtml = (center: Coordinates) => `<!doctype html><html><head>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<link rel="stylesheet" href="https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css">
<style>
html,body,#m{margin:0;padding:0;height:100%;background:#0D1629}
.maplibregl-ctrl-attrib{background:rgba(5,11,24,.75)!important;color:#71809D!important;font-size:9px}
.maplibregl-ctrl-attrib a{color:#AAB6CF!important}
.maplibregl-ctrl-attrib-button{filter:invert(1)}
.maplibregl-popup-content{background:#111D33;color:#F7F8FC;font:600 12px sans-serif;border-radius:10px;padding:8px 10px}
.maplibregl-popup-anchor-bottom .maplibregl-popup-tip{border-top-color:#111D33}
.maplibregl-popup-anchor-top .maplibregl-popup-tip{border-bottom-color:#111D33}
.stop{width:24px;height:24px;border-radius:12px;background:#16223A;border:2px solid #AAB6CF;color:#F7F8FC;font:700 11px sans-serif;display:flex;align-items:center;justify-content:center;box-sizing:border-box}
.stop.cur{width:34px;height:34px;border-radius:17px;background:#FFAA32;border:3px solid #fff;color:#1A1206;font-size:14px;box-shadow:0 0 0 6px rgba(255,170,50,.3)}
.me{width:18px;height:18px;border-radius:9px;background:#3D8BFF;border:3px solid #fff;box-sizing:border-box;box-shadow:0 0 0 8px rgba(61,139,255,.25)}
</style></head><body><div id="m"></div>
<script src="https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js" onerror="window.ReactNativeWebView.postMessage('error')"></script>
<script>
(function(){
  function post(m){window.ReactNativeWebView.postMessage(m);}
  if(!window.maplibregl){post('error');return;}
  var empty={type:'FeatureCollection',features:[]};
  var map=new maplibregl.Map({container:'m',style:'https://tiles.openfreemap.org/styles/fiord',center:[${center.longitude},${center.latitude}],zoom:14,attributionControl:false,pitchWithRotate:false,dragRotate:false});
  map.addControl(new maplibregl.AttributionControl({compact:true}));
  var loaded=false,errors=0,last=null,markers=[];
  map.on('error',function(){if(!loaded&&++errors>=3)post('error');});
  map.on('load',function(){
    map.addSource('area',{type:'geojson',data:empty});
    map.addSource('route',{type:'geojson',data:empty});
    map.addLayer({id:'area-fill',type:'fill',source:'area',paint:{'fill-color':'#FFB340','fill-opacity':0.08}});
    map.addLayer({id:'area-line',type:'line',source:'area',paint:{'line-color':'#FFB340','line-width':1.5,'line-dasharray':[2,2]}});
    map.addLayer({id:'route-casing',type:'line',source:'route',filter:['==',['get','kind'],'path'],layout:{'line-cap':'round','line-join':'round'},paint:{'line-color':'#000','line-width':9,'line-opacity':0.35}});
    map.addLayer({id:'route-line',type:'line',source:'route',filter:['==',['get','kind'],'path'],layout:{'line-cap':'round','line-join':'round'},paint:{'line-color':'#FFAA32','line-width':5}});
    map.addLayer({id:'route-hint',type:'line',source:'route',filter:['==',['get','kind'],'hint'],paint:{'line-color':'#FFAA32','line-width':3,'line-dasharray':[2,3]}});
    loaded=true;post('ready');
  });
  function ll(p){return [p.longitude,p.latitude];}
  function circle(c,r){var pts=[],k=Math.cos(c.latitude*Math.PI/180);for(var i=0;i<=64;i++){var t=i/64*2*Math.PI;pts.push([c.longitude+r/(111320*k)*Math.sin(t),c.latitude+r/111320*Math.cos(t)]);}return pts;}
  function marker(cls,text,p,title){
    var el=document.createElement('div');el.className=cls;el.textContent=text;
    var m=new maplibregl.Marker({element:el}).setLngLat(ll(p));
    if(title)m.setPopup(new maplibregl.Popup({offset:18,closeButton:false}).setText(title));
    m.addTo(map);markers.push(m);
  }
  window.fit=function(animate){
    if(!last)return;
    var pts=last.position?[ll(last.position),ll(last.destination)]:[ll(last.destination)];
    last.path.forEach(function(p){pts.push(ll(p));});
    if(!last.position)last.stops.forEach(function(s){pts.push(ll(s));});
    var b=new maplibregl.LngLatBounds(pts[0],pts[0]);pts.forEach(function(p){b.extend(p);});
    var sw=b.getSouthWest(),ne=b.getNorthEast();
    if(Math.abs(sw.lng-ne.lng)<1e-4&&Math.abs(sw.lat-ne.lat)<1e-4){map.jumpTo({center:pts[0],zoom:15});return;}
    map.fitBounds(b,{padding:40,maxZoom:16,duration:animate?600:0});
  };
  window.update=function(d){
    if(!loaded)return;
    var first=!last;last=d;
    markers.forEach(function(m){m.remove();});markers=[];
    map.getSource('area').setData(d.destination.approximate?{type:'Feature',properties:{},geometry:{type:'Polygon',coordinates:[circle(d.destination,350)]}}:empty);
    var feats=[];
    if(d.path.length>1)feats.push({type:'Feature',properties:{kind:'path'},geometry:{type:'LineString',coordinates:d.path.map(ll)}});
    else if(d.position)feats.push({type:'Feature',properties:{kind:'hint'},geometry:{type:'LineString',coordinates:[ll(d.position),ll(d.destination)]}});
    map.getSource('route').setData({type:'FeatureCollection',features:feats});
    d.stops.filter(function(s){return !s.current;}).forEach(function(s){marker('stop',String(s.order),s,s.name);});
    var cur=d.stops.filter(function(s){return s.current;});
    if(cur.length)cur.forEach(function(s){marker('stop cur',String(s.order),s,s.name);});
    else marker('stop cur','',d.destination,'');
    if(d.position)marker('me','',d.position,'');
    if(first)window.fit(false);
  };
})();
</script></body></html>`;

export default function RouteMap({ destination, position, path, stops }: RouteMapProps) {
  const webRef = useRef<WebView>(null);
  const [html] = useState(() => buildHtml(destination));
  const [attempt, setAttempt] = useState(0);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (ready || failed) return;
    const timer = setTimeout(() => setFailed(true), LOAD_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [ready, failed, attempt]);

  // Push the latest route data into the map whenever it changes.
  useEffect(() => {
    if (!ready) return;
    const payload = JSON.stringify({ destination, position, path, stops });
    webRef.current?.injectJavaScript(`window.update && window.update(${payload}); true;`);
  }, [ready, destination, position, path, stops]);

  const onMessage = (event: WebViewMessageEvent) => {
    if (event.nativeEvent.data === 'ready') { setReady(true); setFailed(false); }
    if (event.nativeEvent.data === 'error') setFailed(true);
  };

  const retry = () => { setReady(false); setFailed(false); setAttempt((n) => n + 1); };

  return (
    <View style={{ height: 260, borderRadius: r.medium, borderWidth: 1, borderColor: c.border, overflow: 'hidden', backgroundColor: c.surface }}>
      <WebView
        key={attempt}
        ref={webRef}
        source={{ html, baseUrl: 'https://localhost/' }}
        originWhitelist={['*']}
        javaScriptEnabled
        domStorageEnabled
        onMessage={onMessage}
        onError={() => setFailed(true)}
        nestedScrollEnabled
        setSupportMultipleWindows={false}
        style={{ flex: 1, backgroundColor: c.surface }}
      />
      {ready && !failed ? (
        <Pressable onPress={() => webRef.current?.injectJavaScript('window.fit && window.fit(true); true;')} hitSlop={6} style={{ position: 'absolute', right: 10, top: 10, width: 38, height: 38, borderRadius: 19, backgroundColor: 'rgba(13,22,41,0.92)', borderWidth: 1, borderColor: c.border, alignItems: 'center', justifyContent: 'center' }}>
          <MaterialCommunityIcons name="crosshairs-gps" size={18} color={c.primary} />
        </Pressable>
      ) : null}
      {!ready && !failed ? (
        <View pointerEvents="none" style={overlay}>
          <ActivityIndicator color={c.primary} />
          <Text style={{ color: c.textSecondary, fontSize: 12, marginTop: 8 }}>Loading map…</Text>
        </View>
      ) : null}
      {failed ? (
        <View style={overlay}>
          <Ionicons name="cloud-offline-outline" size={30} color={c.textMuted} />
          <Text style={{ color: c.text, fontWeight: '700', fontSize: 13, marginTop: 8 }}>Map could not load</Text>
          <Text style={{ color: c.textSecondary, fontSize: 12, marginTop: 4, textAlign: 'center' }}>Check your internet connection and try again.</Text>
          <Pressable onPress={retry} style={{ marginTop: 12, paddingHorizontal: 16, paddingVertical: 8, borderRadius: r.pill, backgroundColor: 'rgba(255,170,50,0.16)' }}>
            <Text style={{ color: c.primary, fontWeight: '800', fontSize: 12 }}>Retry</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

const overlay = { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, backgroundColor: c.surface, alignItems: 'center', justifyContent: 'center', padding: 20 } as const;
