# Mirror — Gobernanza de memoria para agentes de IA
**中文** · [English](README.en.md) · [日本語](README.ja.md) · [Español](README.es.md)

> No "que la IA recuerde más", sino que recuerde lo **correcto**, olvide lo **incorrecto** y sepa **qué fuente manda** cuando hay contradicciones.

Mirror es un plugin para DSH (DeepSeek Harness): destila conversaciones en un *perfil cognitivo* estructurado y aplica reglas de gobernanza para que la memoria no se degrade.

- **Local primero**: SQLite en `~/.mirror`; sin red, sin subir conversaciones
- **Gobernada**: cada memoria tiene autoridad, confianza, alcance y relaciones de conflicto; los conflictos los arbitras tú, la IA no sobrescribe en silencio
- **Empaquetable**: exporta un `.mirrorpack` (las experiencias llevan límites y evidencia)
- **Medible**: `quality.benchmark` comprueba si cada experiencia es recuperable, con línea base

## Instalación (sin npm)

```powershell
# A) descarga mirror-dsh-adapter-x.y.z.tgz desde Releases y ejecuta
node bin/mirror-install.mjs --tarball <tgz descargado>

# B) o instala directamente desde GitHub (repositorio público)
node bin/mirror-install.mjs --from-github gjhhjfgh/mirror-dsh-adapter@v2.2.1

# autocomprobación (reinicia dsh web y refresca la página)
node bin/mirror-doctor.mjs
```

El paquete se copia a `node_modules` del perfil DSH y la dependencia queda como `file:./vendor/…`: no hace falta registro.
Ver [guía de instalación](docs/INSTALL-GITHUB.en.md) · [FAQ](docs/FAQ.en.md).

## Bucle mínimo

1. Panel → *Paquetes de memoria* → activar captura (desactivada por defecto, solo local)
2. Conversa unas rondas o añade reglas a mano
3. Pulsa **Destilar** → preferencias / reglas / patrones / habilidades / evitar / experiencias
4. *Pendientes* → puntuación de calidad, arbitrar conflictos, fusionar duplicados
5. *Vista previa de inyección* → lo que recibirá la siguiente ronda

## De un vistazo

| Capacidad | Qué hace |
|---|---|
| Entradas de experiencia | situación → acción → por qué → límite → evidencia |
| Resolución de autoridad | memoria vs documentos, conserva un lado según `user_first` |
| Búsqueda | FTS5 + vectores n-gram de caracteres + RRF, sin conexión |
| Seguridad | contenido externo como datos, no instrucciones; paquetes sospechosos rechazados |
| Operación | instalación/autodiagnóstico en un comando, copia de seguridad, diagnóstico sin contenido |

## Pruebas

```powershell
node /tests/core.test.mjs
# o: cd  && npm run test:all
```

261 comprobaciones, sin conexión, sin dependencias de terceros.

## Licencia

MIT — ver [LICENSE](LICENSE). El contenido de los paquetes pertenece a su autor; el proyecto no recopila datos de usuarios.
