# Módulo «Portadas» del ERP (copia para revisar)

El código vive en el repositorio del ERP, rama `carlitos/portadas` (desde `main` cfd01a1), y se entrega a Luis con
`erp entregar`. Aquí va una copia en parches para revisarlo desde GitHub sin entrar a la Mac mini:

```bash
cd ~/erp && git switch -c carlitos/portadas main && git am /ruta/a/gancho/deploy/erp/modulo-erp/*.patch
```

Qué agrega: módulo `portadas` (Social Media › Portadas) con permiso `portadas` (ver / crear / aprobar), pantalla con
«Abrir Portadas», `POST /api/portadas/entrar` (token de inicio único hacia Gancho) y `POST /api/portadas/bitacora`
(eventos firmados de Gancho → bitácora de actividad), 16 pruebas y `docs/portadas/README.md`. No toca `core/`,
`deploy/`, `.env.example`, `package.json` ni `CLAUDE.md`.

Verificado: `tsc` del frontend y del servidor sin errores; suite completa 1,529 pruebas bien y 1 mal
(`comercial.test.ts`, que también falla en `main` limpio: depende de la fecha). Prueba cruzada: Gancho acepta el token
que firma el ERP (y rechaza reuso y firma alterada); el ERP acepta la bitácora que firma Gancho (y rechaza la alterada).

Para consultar con Luis (detalle en `docs/portadas/README.md` de la rama):
1. El núcleo rechaza POST con otro `Origin`: Gancho ya manda el `Origin` del ERP en la bitácora.
2. `sistema.` está detrás de Access: la bitácora necesita un *service token* solo para `/api/portadas/bitacora`
   (Gancho ya manda `CF-Access-Client-Id/Secret` con `ERP_BITACORA_CF_ID/SECRET`).
3. Proponer `usuarioPorCorreo` en `core/usuarios.ts` (hoy filtra `usuariosBasicos()` en memoria).
4. Confirmar que el costo estimado puede quedar como `datos.usd` en la bitácora.
5. Al juntar con la rama de Catálogos: conflicto sencillo en la lista `MODULOS` y en las listas de módulos de 5 pruebas.
