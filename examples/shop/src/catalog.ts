// The Aubelle catalogue. Shared by the storefront and the shop backend, which recomputes every cart total from it
// (the browser never tells the backend what to charge).

export type Length = 'Mini' | 'Midi' | 'Maxi';
export type Shade = 'Blush' | 'Rose' | 'Cream' | 'Champagne';
export type Product = {
  slug: string;
  name: string;
  /** Price in US cents. */
  price: number;
  length: Length;
  shade: Shade;
  fabric: string;
  sizes: string[];
  /** Sizes we have run out of; shown struck through. */
  soldOut?: string[];
  description: string;
  details: string[];
  tag?: 'New' | 'Bestseller' | 'Last few';
};

const ALL = ['XS', 'S', 'M', 'L', 'XL'];

export const PRODUCTS: Product[] = [
  { slug: 'camille-slip', name: 'The Camille Slip', price: 24800, length: 'Midi', shade: 'Blush', fabric: 'Silk satin', sizes: ALL, soldOut: ['XS'], tag: 'Bestseller',
    description: 'Cut on the bias so it moves like water. Silk satin in our signature blush, with a soft cowl neckline and whisper-thin straps.',
    details: ['100% mulberry silk satin', 'Bias cut, midi length', 'Adjustable straps', 'Dry clean'] },
  { slug: 'margot-wrap', name: 'Margot Wrap', price: 19800, length: 'Midi', shade: 'Rose', fabric: 'Crepe', sizes: ALL,
    description: 'A true wrap in fluid dusty-rose crepe. Ties at the waist, flutter sleeves, a hem that swings when you walk.',
    details: ['Recycled polyester crepe', 'Self-tie waist', 'Flutter sleeves', 'Machine wash cold'] },
  { slug: 'odette-tulle', name: 'Odette Tulle Gown', price: 42000, length: 'Maxi', shade: 'Blush', fabric: 'Tulle', sizes: ['XS', 'S', 'M', 'L'], tag: 'New',
    description: 'Seven layers of pale pink tulle over a satin slip, gathered at a fitted bodice. For the evenings you will remember.',
    details: ['Nylon tulle, satin lining', 'Fitted boned bodice', 'Concealed back zip', 'Dry clean'] },
  { slug: 'elodie-linen', name: 'Elodie Linen Sundress', price: 16800, length: 'Midi', shade: 'Cream', fabric: 'Linen', sizes: ALL,
    description: 'Washed cream linen with a square neckline and wide straps. Gets softer every summer.',
    details: ['100% European linen', 'Square neckline', 'Side pockets', 'Machine wash cold'] },
  { slug: 'juliette-puff', name: 'Juliette Puff Sleeve', price: 15800, length: 'Mini', shade: 'Blush', fabric: 'Cotton poplin', sizes: ALL, tag: 'New',
    description: 'Crisp powder-pink poplin, generous puff sleeves and a smocked back. A mini with a sense of humour.',
    details: ['Organic cotton poplin', 'Smocked back panel', 'Elasticated sleeves', 'Machine wash cold'] },
  { slug: 'seraphine-pleated', name: 'Séraphine Pleated Maxi', price: 29500, length: 'Maxi', shade: 'Champagne', fabric: 'Chiffon', sizes: ALL,
    description: 'Sunray-pleated champagne chiffon that catches the light from every angle. Halter neck, open back.',
    details: ['Pleated polyester chiffon', 'Halter neckline', 'Open back', 'Hand wash'] },
  { slug: 'colette-tweed', name: 'Colette Tweed Mini', price: 34000, length: 'Mini', shade: 'Rose', fabric: 'Bouclé tweed', sizes: ['XS', 'S', 'M', 'L'], soldOut: ['M'], tag: 'Last few',
    description: 'A structured shift in pink bouclé tweed with frayed edges and pearl-tone buttons.',
    details: ['Wool-blend bouclé', 'Fully lined', 'Frayed trims', 'Dry clean'] },
  { slug: 'ines-floral', name: 'Inès Floral Midi', price: 18800, length: 'Midi', shade: 'Cream', fabric: 'Viscose', sizes: ALL,
    description: 'Tiny rose sprigs on a cream ground, three soft tiers and a tie neck. The garden-party dress.',
    details: ['Printed viscose', 'Tiered skirt', 'Tie neckline', 'Hand wash'] },
  { slug: 'lucie-corset', name: 'Lucie Corset Midi', price: 36500, length: 'Midi', shade: 'Cream', fabric: 'Duchess satin', sizes: ['XS', 'S', 'M', 'L'], tag: 'New',
    description: 'An ivory duchess-satin corset bodice over a full midi skirt. Sculpted, but you can still dance.',
    details: ['Duchess satin', 'Boned corset bodice', 'Back lacing', 'Dry clean'] },
  { slug: 'rosalie-knit', name: 'Rosalie Rib Knit', price: 17800, length: 'Midi', shade: 'Rose', fabric: 'Rib knit', sizes: ALL,
    description: 'A close-fitting rib knit in deep rose, long sleeves and a scoop neck. Warm, simple, very hard to take off.',
    details: ['Merino-cotton rib', 'Long sleeves', 'Scoop neck', 'Hand wash'] },
  { slug: 'amelie-gingham', name: 'Amélie Gingham', price: 14800, length: 'Mini', shade: 'Blush', fabric: 'Cotton', sizes: ALL, tag: 'Bestseller',
    description: 'Pink gingham, shoulder ties and a skirt with a little volume. Picnic-ready.',
    details: ['100% cotton gingham', 'Shoulder ties', 'Side zip', 'Machine wash cold'] },
  { slug: 'vivienne-velvet', name: 'Vivienne Velvet Column', price: 31000, length: 'Maxi', shade: 'Rose', fabric: 'Velvet', sizes: ALL,
    description: 'A rose velvet column with a cowl back. Quiet from the front, a statement from behind.',
    details: ['Silk-blend velvet', 'Cowl back', 'Floor length', 'Dry clean'] },
  { slug: 'celeste-lace', name: 'Céleste Lace', price: 38500, length: 'Midi', shade: 'Cream', fabric: 'Lace', sizes: ['XS', 'S', 'M', 'L', 'XL'], soldOut: ['XL'],
    description: 'Ivory corded lace at tea length, with a scalloped hem and sheer sleeves.',
    details: ['Corded cotton lace', 'Scalloped hem', 'Sheer long sleeves', 'Dry clean'] },
  { slug: 'noemie-shirt', name: 'Noémie Shirt Dress', price: 17200, length: 'Midi', shade: 'Blush', fabric: 'Cotton', sizes: ALL,
    description: 'A blush shirt dress in soft cotton with a self belt. Desk to dinner without changing.',
    details: ['Brushed cotton', 'Self belt', 'Button front', 'Machine wash cold'] },
  { slug: 'fleur-ruffle', name: 'Fleur Ruffle Maxi', price: 26800, length: 'Maxi', shade: 'Blush', fabric: 'Georgette', sizes: ALL,
    description: 'Tier upon tier of peach-pink georgette ruffles, from the shoulder to the floor.',
    details: ['Polyester georgette', 'Tiered ruffles', 'Smocked bodice', 'Hand wash'] },
];

export const bySlug = (slug: string) => PRODUCTS.find(p => p.slug === slug);
export const usd = (cents: number) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;

export type CartLine = { slug: string; size: string; qty: number };
export const MAX_QTY = 5;

/** Validates cart lines against the catalogue and returns priced lines plus the total in cents. Throws on anything odd. */
export function priceCart(lines: unknown): { lines: (CartLine & { name: string; price: number })[]; total: number } {
  if (!Array.isArray(lines) || lines.length === 0 || lines.length > 20) throw new Error('Your bag is empty');
  const priced = lines.map((line: any) => {
    const product = bySlug(String(line?.slug));
    if (!product) throw new Error(`Unknown product ${String(line?.slug)}`);
    if (!product.sizes.includes(line.size) || product.soldOut?.includes(line.size)) throw new Error(`${product.name} is not available in ${String(line.size)}`);
    if (!Number.isInteger(line.qty) || line.qty < 1 || line.qty > MAX_QTY) throw new Error(`Quantity must be 1 to ${MAX_QTY}`);
    return { slug: product.slug, size: line.size as string, qty: line.qty as number, name: product.name, price: product.price };
  });
  return { lines: priced, total: priced.reduce((sum, l) => sum + l.price * l.qty, 0) };
}
