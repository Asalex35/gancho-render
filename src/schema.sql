-- Esquema de Gancho. Se aplica solo al arrancar (idempotente).

CREATE TABLE IF NOT EXISTS usuarios (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario     text UNIQUE NOT NULL,
  clave_hash  text NOT NULL,
  rol         text NOT NULL DEFAULT 'editor' CHECK (rol IN ('admin', 'editor')),
  activo      boolean NOT NULL DEFAULT true,
  creado      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS canales (
  id               text PRIMARY KEY,               -- ej. CLAC
  nombre           text NOT NULL,
  voz              text NOT NULL DEFAULT '',
  descripcion_fija text NOT NULL DEFAULT '',
  disclaimer       text NOT NULL DEFAULT '',
  hashtags_base    jsonb NOT NULL DEFAULT '[]',
  logo_key         text,
  activo           boolean NOT NULL DEFAULT true,
  creado           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS actores (
  id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre  text NOT NULL,
  fotos   jsonb NOT NULL DEFAULT '[]',              -- llaves de almacenamiento
  creado_por text,
  creado  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS actores_nombre_idx ON actores (lower(nombre));

CREATE TABLE IF NOT EXISTS lotes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre      text NOT NULL,
  canal       text NOT NULL REFERENCES canales(id),
  modelo      text NOT NULL DEFAULT 'nb2',
  auto_elegir boolean NOT NULL DEFAULT false,
  creado_por  text NOT NULL,
  creado      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS episodios (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lote_id     uuid REFERENCES lotes(id) ON DELETE CASCADE,
  orden       int NOT NULL DEFAULT 0,
  titulo      text NOT NULL,
  canal       text NOT NULL REFERENCES canales(id),
  modelo      text NOT NULL DEFAULT 'nb2',
  brief       jsonb NOT NULL,                       -- sinopsis, giro, momento, desenlace, escenario, notas
  "cast"      jsonb NOT NULL DEFAULT '[]',
  estado      text NOT NULL DEFAULT 'borrador',     -- borrador, en_cola, pensando, listo, error
  error       text,
  gancho      jsonb,
  elegida     uuid,
  paquete     jsonb,
  eligiendo   boolean NOT NULL DEFAULT false,
  creado_por  text NOT NULL,
  creado      timestamptz NOT NULL DEFAULT now(),
  actualizado timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS episodios_lote_idx ON episodios (lote_id, orden);
CREATE INDEX IF NOT EXISTS episodios_act_idx ON episodios (actualizado DESC);

CREATE TABLE IF NOT EXISTS propuestas (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  episodio_id uuid NOT NULL REFERENCES episodios(id) ON DELETE CASCADE,
  slot        int NOT NULL,
  version     int NOT NULL DEFAULT 1,
  archivada   boolean NOT NULL DEFAULT false,
  data        jsonb NOT NULL,                       -- titulo, formula, composicion, concepto, prompt_imagen...
  imagen      jsonb NOT NULL DEFAULT '{"estado":"en_cola","intentos":0}',
  evaluacion  jsonb,
  evaluando   boolean NOT NULL DEFAULT false,
  rehaciendo  text,
  error_rehacer text,
  editado     boolean NOT NULL DEFAULT false,
  creado      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS propuestas_ep_idx ON propuestas (episodio_id) WHERE NOT archivada;

CREATE TABLE IF NOT EXISTS versiones (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  propuesta_id uuid NOT NULL REFERENCES propuestas(id) ON DELETE CASCADE,
  data         jsonb NOT NULL,
  imagen       jsonb,
  evaluacion   jsonb,
  feedback     jsonb,
  creado       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS versiones_prop_idx ON versiones (propuesta_id, creado);

CREATE TABLE IF NOT EXISTS feedback (
  id          bigserial PRIMARY KEY,
  canal       text NOT NULL,
  episodio_id uuid,
  usuario     text,
  titulo      text,
  objetivo    text,
  razones     jsonb NOT NULL DEFAULT '[]',
  comentario  text,
  creado      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS feedback_canal_idx ON feedback (canal, creado DESC);

CREATE TABLE IF NOT EXISTS uso (
  dia      date NOT NULL DEFAULT current_date,
  usuario  text NOT NULL,
  imagenes int NOT NULL DEFAULT 0,
  textos   int NOT NULL DEFAULT 0,
  PRIMARY KEY (dia, usuario)
);

-- v2: canales multi-idioma y flujo automático
ALTER TABLE canales ADD COLUMN IF NOT EXISTS idioma text NOT NULL DEFAULT 'es';
ALTER TABLE canales ADD COLUMN IF NOT EXISTS pais text NOT NULL DEFAULT '';
ALTER TABLE canales ADD COLUMN IF NOT EXISTS estilo_visual text NOT NULL DEFAULT '';
ALTER TABLE canales ADD COLUMN IF NOT EXISTS ejemplos jsonb NOT NULL DEFAULT '[]';
ALTER TABLE canales ADD COLUMN IF NOT EXISTS tags_base jsonb NOT NULL DEFAULT '[]';
ALTER TABLE canales ADD COLUMN IF NOT EXISTS modelo text NOT NULL DEFAULT 'nb2';
ALTER TABLE canales ADD COLUMN IF NOT EXISTS auto_aprobar int;          -- calificación mínima para aprobar sola (NULL = nunca)
ALTER TABLE canales ADD COLUMN IF NOT EXISTS webhook_url text;          -- avisos a Slack / Google Chat / Discord

ALTER TABLE episodios ADD COLUMN IF NOT EXISTS origen text NOT NULL DEFAULT 'manual';   -- manual, lote, auto
ALTER TABLE episodios ADD COLUMN IF NOT EXISTS video jsonb;                             -- key, etapa, duracion, cuadros...
ALTER TABLE episodios ADD COLUMN IF NOT EXISTS aprobacion text;                         -- por_aprobar, auto, manual
CREATE INDEX IF NOT EXISTS episodios_origen_idx ON episodios (origen, actualizado DESC);

-- v3: robustez
ALTER TABLE lotes ADD COLUMN IF NOT EXISTS notificado boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS propuestas_ep_all_idx ON propuestas (episodio_id);
CREATE INDEX IF NOT EXISTS episodios_estado_idx ON episodios (estado, actualizado) WHERE estado IN ('en_cola','pensando','procesando');
-- Un mismo video subido no se puede registrar dos veces.
CREATE UNIQUE INDEX IF NOT EXISTS episodios_video_key_uq ON episodios ((video->>'key')) WHERE video->>'key' IS NOT NULL;

-- v4: biblioteca de rostros por actor (con permiso de los actores)
CREATE TABLE IF NOT EXISTS actor_caras (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id    uuid NOT NULL REFERENCES actores(id) ON DELETE CASCADE,
  key         text NOT NULL,              -- recorte de la cara (768×768)
  huella      real[] NOT NULL,            -- 128 números para comparar rostros
  calidad     real NOT NULL DEFAULT 0,
  giro        real NOT NULL DEFAULT 0,
  origen      text NOT NULL DEFAULT 'foto', -- foto (subida) o episodio
  foto_key    text,                       -- foto original de la que salió (origen foto)
  episodio_id uuid,
  creado      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS actor_caras_actor_idx ON actor_caras (actor_id, calidad DESC);
ALTER TABLE actores ADD COLUMN IF NOT EXISTS auto boolean NOT NULL DEFAULT false; -- creado por Gancho, falta ponerle nombre
ALTER TABLE canales ALTER COLUMN modelo SET DEFAULT 'pro';

-- Videos de otros canales para la vista previa "Así se ve en YouTube".
CREATE TABLE IF NOT EXISTS competencia (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id   text NOT NULL UNIQUE,
  titulo     text NOT NULL,
  autor      text NOT NULL DEFAULT '',
  vistas     bigint,
  publicado  timestamptz,
  creado_por text,
  creado     timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE competencia ADD COLUMN IF NOT EXISTS duracion text;
