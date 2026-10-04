// Server-side access to every shipped catalog (email rendering, push copy).
// The web app loads catalogs lazily via import.meta.glob instead, so it never imports this file.
import type { Locale } from '@chatme/contracts/constants';
import { flattenCatalog, type Catalog } from './index.js';
import en from '../locales/en.json' with { type: 'json' };
import es from '../locales/es.json' with { type: 'json' };
import pt from '../locales/pt.json' with { type: 'json' };
import fr from '../locales/fr.json' with { type: 'json' };
import de from '../locales/de.json' with { type: 'json' };
import it from '../locales/it.json' with { type: 'json' };
import nl from '../locales/nl.json' with { type: 'json' };
import tr from '../locales/tr.json' with { type: 'json' };
import ar from '../locales/ar.json' with { type: 'json' };
import hi from '../locales/hi.json' with { type: 'json' };
import bn from '../locales/bn.json' with { type: 'json' };
import ur from '../locales/ur.json' with { type: 'json' };
import id from '../locales/id.json' with { type: 'json' };
import fil from '../locales/fil.json' with { type: 'json' };
import vi from '../locales/vi.json' with { type: 'json' };
import th from '../locales/th.json' with { type: 'json' };
import ja from '../locales/ja.json' with { type: 'json' };
import ko from '../locales/ko.json' with { type: 'json' };

const raw: Record<Locale, unknown> = { en, es, pt, fr, de, it, nl, tr, ar, hi, bn, ur, id, fil, vi, th, ja, ko };
const cache = new Map<Locale, Catalog>();

export function getCatalog(locale: Locale): Catalog {
  let c = cache.get(locale);
  if (!c) {
    c = flattenCatalog(raw[locale]);
    cache.set(locale, c);
  }
  return c;
}
