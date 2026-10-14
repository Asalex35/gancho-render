# Módulo «Kit de publicación» del ERP (Prisma Studio) · copia para revisar

El código vive en el repositorio del ERP, rama `carlitos/portadas` (desde `main` cfd01a1), y se entrega a Luis con
`erp entregar`. Aquí va una copia en parches para revisarlo desde GitHub sin entrar a la Mac mini:

```bash
cd ~/erp && git switch -c carlitos/portadas main && git am /ruta/a/gancho/deploy/erp/modulo-erp/*.patch
```

Qué agrega: un espacio nuevo en el menú, **Prisma Studio** (después de Social Media, mismo color), y dentro el
**Kit de publicación** (módulo técnico `portadas`) con permiso (ver / crear / aprobar), pantalla con «Abrir Kit de publicación», `POST /api/portadas/entrar` (token de inicio único hacia Gancho) y `POST /api/portadas/bitacora`
(eventos firmados de Gancho → bitácora de actividad), pruebas y `docs/portadas/README.md`. Del núcleo solo toca `src/core/menu.tsx` (el espacio
Prisma Studio), en un commit aparte (parche 0005) **para el visto bueno de Luis**; nada de `deploy/`, `.env.example`,
`package.json` ni `CLAUDE.md`.

Verificado: `tsc` del frontend y del servidor sin errores; suite completa 1,530 pruebas bien y 1 mal
(`comercial.test.ts`, que también falla en `main` limpio: depende de la fecha). Prueba cruzada: Gancho acepta el token
que firma el ERP (y rechaza reuso y firma alterada); el ERP acepta la bitácora que firma Gancho (y rechaza la alterada).

Para consultar con Luis (detalle en `docs/portadas/README.md` de la rama):
0. Aprobar el espacio Prisma Studio en el menú (parche 0005) y si quiere color propio. Las claves técnicas siguen como
   `portadas` (rutas, permiso, bitácora); si se renombran, que sea antes de producción.
1. El núcleo rechaza POST con otro `Origin`: Gancho ya manda el `Origin` del ERP en la bitácora.
2. `sistema.` está detrás de Access: la bitácora necesita un *service token* solo para `/api/portadas/bitacora`
   (Gancho ya manda `CF-Access-Client-Id/Secret` con `ERP_BITACORA_CF_ID/SECRET`).
3. Proponer `usuarioPorCorreo` en `core/usuarios.ts` (hoy filtra `usuariosBasicos()` en memoria).
4. Confirmar que el costo estimado puede quedar como `datos.usd` en la bitácora.
5. Al juntar con la rama de Catálogos: conflicto sencillo en la lista `MODULOS` y en las listas de módulos de 5 pruebas.
