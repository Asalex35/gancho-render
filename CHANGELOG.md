# Cambios de Gancho

## 0.2.0 — 2026-10-12
- **Vista previa "Así se ve en YouTube"**: cada portada se ve en computadora (inicio y sugeridos), celular (inicio y búsqueda) y televisión, rodeada de portadas reales de otros canales.
- **Competencia**: se pegan links de canales o videos (sin llave). Con `YOUTUBE_API_KEY` también se ve junto a tendencias de México y búsquedas reales, con vistas y duración.
- **Portadas más claras**: el prompt pide luz brillante y colores vivos; si una portada sale oscura (menos de 105 de luz, la competencia promedia ~116) se aclara sola.
- **Más parecido**: con pocas fotos del actor se manda también la foto original (peinado y vestuario), no solo la cara recortada.
- **Créditos**: si un repintado automático falla (p. ej. sin créditos), se conserva la portada anterior; no se repinta si no se sabe el saldo; "sin créditos" ya no se reintenta solo.
- **Seguridad de marca**: un adulto con pareja nunca lleva algo que parezca uniforme escolar.

## 0.1.0
- Portadas, títulos, descripción y tags con 3 propuestas calificadas; flujos manual, masivo y automático desde el video; canales en es/en/pt; biblioteca de caras por actor; proveedores de imagen de respaldo.
