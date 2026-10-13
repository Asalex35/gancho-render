// Versiones de una portada para otras plataformas: redes sociales y Prisma Plus (la app de Prismáticoos).
// Cada formato se pinta aparte (con las mismas fotos de los actores) porque cambia la composición, no solo el recorte.

export const FORMATOS = {
  tiktok: {
    nombre: "TikTok · Reels",
    grupo: "redes",
    aspecto: "9:16", ancho: 1080, alto: 1920,
    texto: "titulo_grande",
    guia: `Vertical cover in the style of short-drama series apps (DramaShorts, ReelShort, DramaBox).
Two or three leads in a charged close moment (confrontation, forbidden embrace, betrayal discovered), tight vertical framing,
glossy high-end look, rich saturated color grade (warm golds vs cool teal), soft glow and bokeh, luxurious or dramatic setting.
The SERIES TITLE is rendered big inside the image in the lower third: elegant bold display lettering (serif or brush script)
with metallic gold or white glow, max 5 words, spelled EXACTLY as given. Optional tiny tagline above it.
Keep the top 12% and the bottom 10% free of faces and text (app UI covers them).`,
  },
  instagram: {
    nombre: "Instagram · feed 4:5",
    grupo: "redes",
    aspecto: "4:5", ancho: 1080, alto: 1350,
    texto: "ninguno",
    guia: `Instagram feed post 4:5. Editorial, cinematic still: one powerful emotional moment, faces large and sharp,
clean background with depth of field, premium magazine-like color grade. NO text, NO letters, NO logos.`,
  },
  facebook: {
    nombre: "Facebook · post 1:1",
    grupo: "redes",
    aspecto: "1:1", ancho: 1080, alto: 1080,
    texto: "frase_corta",
    guia: `Square Facebook feed post. Readable at small size on a phone: two faces with extreme, opposite emotions,
bright clean lighting, saturated colors. A SHORT hook phrase (max 6 words, spelled EXACTLY as given) in bold white lettering
with a dark soft shadow in the top area, not covering faces.`,
  },
  prisma_poster: {
    nombre: "Prisma Plus · póster de película",
    grupo: "prisma",
    aspecto: "2:3", ancho: 1400, alto: 2100, resolucion: "2K",
    texto: "titulo_pelicula",
    guia: `Theatrical one-sheet movie poster, indistinguishable from a real studio release. Photorealistic, shot on ARRI Alexa
with anamorphic lenses, 35mm film grain, motivated cinematic lighting, deep contrast, filmic color grade (teal and orange or
moody desaturated tones), real skin texture. Classic key-art composition: the lead large in the upper half, the other
characters smaller and layered, a symbolic element from the story. The MOVIE TITLE big and elegant in the lower third
(custom film-title lettering, spelled EXACTLY as given), a short tagline above it, and a small credits block
(thin condensed letters, illegible-style billing block is fine) at the bottom. No studio logos, no rating badges.`,
  },
  prisma_banner: {
    nombre: "Prisma Plus · banner de la app 16:9",
    grupo: "prisma",
    aspecto: "16:9", ancho: 1920, alto: 1080, resolucion: "2K",
    texto: "titulo_pelicula",
    guia: `Streaming-app hero banner (like Netflix / Max key art), photorealistic and cinematic: characters on the RIGHT half,
the LEFT 40% is darker negative space with the MOVIE TITLE as an elegant film-title logo (spelled EXACTLY as given)
and nothing else, so the app can place buttons over it. Anamorphic lighting, film grain, premium color grade, real skin texture.
No tagline, no credits, no studio logos.`,
  },
};

export const TIPOS = Object.keys(FORMATOS);
