// Standard-Kategorien (Symbol-Namen siehe icons.js). color = Fläche (Marker, gewählter Filter),
// ink = dunklerer Ton für Symbole und Beschriftung auf hellem Grund. Reihenfolge = Priorität bei der automatischen Erkennung:
// die erste Kategorie, deren Stichwort im Namen/in der Notiz vorkommt, gewinnt.
export const DEFAULT_CATEGORIES = [
  {
    id: 'kaffee', label: 'Kaffee', icon: 'coffee', color: '#D9A77C', ink: '#8A5A34',
    keywords: ['café', 'cafe', 'caffè', 'coffee', 'kaffee', 'espresso', 'roaster', 'bakery', 'bäckerei',
      'forn ', 'panader', 'pastisseria', 'ensaïmada', 'brunch', 'granja'],
  },
  {
    id: 'restaurant', label: 'Restaurant', icon: 'utensils', color: '#E98A78', ink: '#A8352D',
    keywords: ['restaurant', 'restaurante', 'ristorante', 'celler', 'tapas', 'bistro', 'bistrot', 'trattoria',
      'pizzeria', 'cuina', 'marisquer', 'asador', 'steakhouse', 'sushi', 'taverna'],
  },
  {
    id: 'rennrad', label: 'Rennrad-Hotspot', icon: 'bike', color: '#8FB783', ink: '#3F6B34',
    keywords: ['coll ', 'coll de', 'sa calobra', 'formentor', 'puig major', 'lluc ', 'cycling', 'cyclist',
      'bike', 'bici', 'ciclis', 'rennrad', 'radsport', 'climb', 'anstieg', 'bergpass', 'ma-10', 'velo'],
  },
  {
    id: 'strand', label: 'Strand & Bucht', icon: 'waves', color: '#8CC3DB', ink: '#2F6E8C',
    keywords: ['platja', 'playa', 'beach', 'cala ', 'caló', 'strand', 'bucht', 'badestelle', 'beach club'],
  },
  {
    id: 'aussicht', label: 'Aussicht & Natur', icon: 'mountain', color: '#C3D38B', ink: '#54742F',
    keywords: ['mirador', 'viewpoint', 'aussicht', 'lighthouse', 'leuchtturm', 'far de', 'cap de', 'torrent',
      'parc natural', 'trail', 'wanderweg', 'hike', 'sunset', 'sonnenuntergang', 'gipfel'],
  },
  {
    id: 'kultur', label: 'Kultur & Orte', icon: 'landmark', color: '#E3A89B', ink: '#9C3F35',
    keywords: ['museu', 'museo', 'museum', 'cathedral', 'catedral', 'kathedrale', 'la seu', 'monestir',
      'monastery', 'kloster', 'santuari', 'castell', 'castle', 'burg', 'església', 'iglesia', 'church',
      'kirche', 'gallery', 'galeria', 'galerie', 'fundació'],
  },
  {
    id: 'einkaufen', label: 'Märkte & Shops', icon: 'bag', color: '#F2C95C', ink: '#8A620A',
    keywords: ['mercat', 'mercado', 'market', 'markt', 'shop', 'store', 'boutique', 'supermerc',
      'supermarkt', 'ceràmica', 'ceramic', 'bodega', 'celler de vins', 'weingut', 'winery'],
  },
  {
    id: 'bar', label: 'Bar & Drinks', icon: 'wine', color: '#F29A66', ink: '#B5501F',
    keywords: ['bar ', ' bar', 'cocktail', 'wine bar', 'vinoteca', 'vermut', 'pub ', 'rooftop', 'drinks'],
  },
  { id: 'sonstiges', label: 'Sonstiges', icon: 'pin', color: '#C9C9B8', ink: '#5E5E50', keywords: [] },
];

export const FALLBACK_CATEGORY = 'sonstiges';

// Eigene "Art" für importierte GPX-Strecken (Linien statt Punkte) – bewusst NICHT Teil von
// DEFAULT_CATEGORIES, damit sie nicht in der Kategorie-Auswahl einzelner Orte auftaucht.
// Gleiche Farbfamilie wie „Rennrad-Hotspot“ (Icon unterscheidet Punkt vs. Strecke).
export const ROUTE_CATEGORY = { id: 'rennrad-route', label: 'Rennrad-Route', icon: 'route', color: '#8FB783', ink: '#3F6B34' };

const normalize = (s) => ` ${String(s || '').toLowerCase().normalize('NFC')} `;

// Findet eine Kategorie über den Namen einer Liste/Datei (z. B. "Kaffee.csv", "Rennrad Mallorca").
export function categoryFromHint(hint, categories) {
  if (!hint) return null;
  const h = normalize(hint);
  for (const c of categories) {
    if (c.id === FALLBACK_CATEGORY) continue;
    if (h.includes(c.label.toLowerCase()) || h.includes(c.id)) return c.id;
  }
  return classify(hint, categories, null);
}

// Rät die Kategorie anhand von Stichwörtern. Google exportiert keine Orts-Typen,
// daher ist das eine Heuristik – die Kategorie lässt sich in der Liste jederzeit ändern.
export function classify(text, categories, fallback = FALLBACK_CATEGORY) {
  const t = normalize(text);
  for (const c of categories) {
    if ((c.keywords || []).some((k) => t.includes(k.toLowerCase()))) return c.id;
  }
  return fallback;
}
