"use client";
// Leaflet map of trial sites around the patient. Loaded only in the browser (see trial-view.tsx).
// Circle markers need no image assets. Tiles are OpenStreetMap's standard set (free with attribution, no key),
// toned to grayscale in globals.css (.map-tiles) so they sit quietly behind the app's colors.
import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

export interface MapSite { lat: number; lon: number; label: string; recruiting: boolean }

export default function SitesMap({ home, homeLabel, sites, focus }: {
  home: [number, number] | null; homeLabel: string; sites: MapSite[]; focus: [number, number][];
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!box.current) return;
    const map = L.map(box.current, { scrollWheelZoom: false, attributionControl: true });
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 18, className: "map-tiles",
    }).addTo(map);
    // Non-recruiting sites first, so recruiting ones draw on top.
    for (const s of [...sites].sort((a, b) => Number(a.recruiting) - Number(b.recruiting))) {
      L.circleMarker([s.lat, s.lon], {
        radius: s.recruiting ? 6 : 4, weight: 1.5,
        color: s.recruiting ? "#2F6B4F" : "#A39A90", fillColor: s.recruiting ? "#2F6B4F" : "#D3CFC6", fillOpacity: s.recruiting ? 0.85 : 0.6,
      }).bindTooltip(s.label).addTo(map);
    }
    if (home) {
      L.circleMarker(home, { radius: 9, weight: 3, color: "#080503", fillColor: "#FFFFFF", fillOpacity: 1 })
        .bindTooltip(homeLabel, { permanent: true, direction: "top", offset: [0, -8] }).addTo(map);
    }
    const pts = focus.length ? focus : sites.map((s) => [s.lat, s.lon] as [number, number]);
    if (pts.length) map.fitBounds(L.latLngBounds(pts).pad(0.25), { maxZoom: 10 });
    else map.setView(home ?? [39.8, -98.6], home ? 9 : 3);
    return () => { map.remove(); };
  }, [home, homeLabel, sites, focus]);
  return <div ref={box} className="h-[320px] w-full overflow-hidden rounded-xl border border-line" aria-label="Map of trial sites" />;
}
