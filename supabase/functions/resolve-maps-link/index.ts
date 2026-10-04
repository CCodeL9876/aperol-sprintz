// Supabase Edge Function „resolve-maps-link“: löst Google-Maps-Kurzlinks (aus „Teilen → Kopieren“ in der
// Google-Maps-App) in die lange Adresse auf, die Name und Koordinaten enthält. Der Browser darf diese
// Weiterleitung einer fremden Seite nicht selbst auslesen – ein Server schon.
//
// Bewusst eng gefasst: nimmt nur maps.app.goo.gl- und goo.gl/maps-Links an, folgt nur Weiterleitungen
// innerhalb dieser Adressen und gibt nur Google-Maps-Adressen zurück. Speichert und protokolliert nichts.
// Einrichtung: ANLEITUNG.md, Abschnitt „Google-Maps-Kurzlinks“ (JWT-Prüfung für diese Funktion aus).

const SHORT = /^https:\/\/(maps\.app\.goo\.gl\/|goo\.gl\/maps\/)[A-Za-z0-9_\-?=&.%]+$/;
const LONG = /^https:\/\/(www\.)?google\.[a-z.]{2,6}\/maps|^https:\/\/maps\.google\.[a-z.]{2,6}\//;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'nur POST' }, 405);
  let url = '';
  try {
    url = String((await req.json())?.url || '').trim();
  } catch {
    return json({ error: 'ungültige Anfrage' }, 400);
  }
  if (url.length > 300 || !SHORT.test(url)) return json({ error: 'nur Google-Maps-Kurzlinks' }, 400);

  let current = url;
  try {
    // Höchstens drei Sprünge, und nur solange wir uns noch auf einer Kurzlink-Adresse befinden
    for (let i = 0; i < 3 && SHORT.test(current); i++) {
      const res = await fetch(current, {
        redirect: 'manual',
        headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' },
        signal: AbortSignal.timeout(6000),
      });
      const location = res.headers.get('location');
      await res.body?.cancel();
      if (!location) break;
      current = new URL(location, current).href;
    }
  } catch (err) {
    return json({ error: `nicht erreichbar: ${err instanceof Error ? err.message : err}` }, 502);
  }
  if (!LONG.test(current)) return json({ error: 'kein Google-Maps-Ziel' }, 422);
  return json({ url: current });
});
