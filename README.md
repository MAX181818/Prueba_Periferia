# Agente de órdenes de compra — Periferia

Aplicación del reto 03: chat, controles deterministas RC1–RC10, evidencia de aprobación y SAP simulado. TypeScript con Node 20+.

## Arranque

```powershell
npm ci
npm run local
```

Requisitos: Windows, Node 20 o superior y [Ollama instalado](https://ollama.com/download/windows). Abrir http://localhost:3000 después del arranque. `npm run local` inicia Ollama y el chat con `qwen3:4b-instruct-2507-q4_K_M`. Si falta el modelo, lo descarga una vez (aproximadamente 2,5 GB). Ollama y los pesos se instalan por separado; no están incluidos en el ZIP. La instalación inicial depende de la conexión y no se ha verificado el requisito de arranque en menos de dos minutos en una máquina limpia.

En este equipo se instaló Ollama portátil en `%LOCALAPPDATA%/Programs/PeriferiaOllama` y los modelos están en `%LOCALAPPDATA%/PeriferiaOC/models`. El lanzador usa solamente `127.0.0.1`, desactiva las funciones de nube para el proceso que inicia y mantiene una sola carga de modelo a la vez, con caché KV q8_0 para reducir el uso de memoria. No necesita cuenta ni clave de API. Los datos de las herramientas se envían al modelo en este equipo. La descarga inicial sí requiere internet. Un servicio Ollama ya iniciado conserva su configuración; para asegurar la opción de nube desactivada, cerrarlo y arrancar con este comando.

Alternativa manual: ejecutar `ollama serve` con `OLLAMA_NO_CLOUD=1`, descargar el modelo con `ollama pull qwen3:4b-instruct-2507-q4_K_M`, copiar `.env.example` a `.env` y ejecutar `npm run dev`. Sin `.env` ni `npm run local`, el servidor mantiene el modo offline identificado: es un simulador de pruebas, no un modelo de lenguaje.

## Proveedor externo opcional

Copiar `.env.example` a `.env`. Configurar `LLM_MODE=openai`, `LLM_API_KEY`, `LLM_MODEL` y `LLM_BASE_URL` para un proveedor compatible con Chat Completions que soporte llamadas a herramientas. Las claves permanecen en backend. Reiniciar después de configurar.

Solo esta alternativa externa requiere una clave y crédito del proveedor. Para Ollama local no se usan. Nunca compartir `.env`, claves en capturas, repositorio ni logs. Verificar `/api/health` y realizar un turno real antes de la defensa. El modo offline no se presenta como IA conectada.

## Verificación

```powershell
npm run typecheck
npm run demo
```

La demo reinicia exclusivamente la carpeta `out/`; guardar cualquier salida que se desee conservar antes de ejecutarla. Procesa los seis fixtures, repite sol-001 para verificar idempotencia y confirma expresamente sol-004. Los fixtures originales no se modifican.

| Caso | Resultado esperado |
|---|---|
| sol-001 | OC creada; repetir devuelve el mismo número |
| sol-002 | Bloqueado: proveedor inexistente |
| sol-003 | Bloqueado: aprobador sin autoridad para el centro |
| sol-004 | Pendiente por diferencia 25.000.000 vs 26.500.000; crear tras confirmación |
| sol-005 | Compra retroactiva; requiere confirmación |
| sol-006 | IVA derivado; requiere confirmación; pago derivado solo se informa |

## Defensa

1. Nueva sesión: `Procesa la solicitud sol-004. Muéstrame la OC como quedaría en SAP y no la crees hasta que yo lo confirme.`
2. Revisar las llamadas a herramientas, el monto y la confirmación.
3. Responder `confirmo`; comprobar el número y la evidencia.
4. Mostrar sol-002 y sol-003: confirmar no permite superar bloqueos.
5. Mostrar sol-001 dos veces y sol-005 como control retroactivo.

Para una defensa extensa, reiniciar el servidor entre bloques de casos para renovar su presupuesto global; completar antes cualquier confirmación pendiente, porque las sesiones están en memoria. Las órdenes y evidencias se conservan.

## API

- `POST /api/chat`: `{ "sessionId": "opcional", "message": "Procesa sol-001" }`; respuesta con `sessionId`, `reply`, `toolCalls` y `needsConfirmation`.
- `GET /api/sessions/:id`: historial de la sesión.
- `GET /api/health`: estado y proveedor/modelo sin credenciales.
- `GET /api/cases`: casos de ejemplo.

Cada llamada aparece en el chat y en `out/log.jsonl`. `out/control.csv` registra intentos; `out/sap/ordenes.jsonl` contiene las órdenes. La evidencia y trazabilidad viven en `out/<caso>/`.

## Variables

| Variable | Uso |
|---|---|
| PORT / HOST | Puerto y dirección de escucha |
| LLM_MODE | ollama (local real), offline (simulador) u openai (externo) |
| LLM_MODEL | Modelo con herramientas; por defecto local Qwen3 Instruct 4B |
| OLLAMA_BASE_URL | Endpoint HTTP local; por defecto http://127.0.0.1:11434 |
| OLLAMA_NUM_CTX | Contexto del modelo local; por defecto 16.384 |
| LLM_BASE_URL | Endpoint compatible para modo openai |
| LLM_API_KEY | Clave backend; OPENAI_API_KEY es alias |
| MAX_ITERATIONS | Máximo de iteraciones por turno |
| MAX_SESSION_TOKENS | Reserva conservadora por sesión; default 400.000 |
| MAX_GLOBAL_TOKENS | Reserva conservadora del proceso; default 1.000.000 |
| MAX_COMPLETION_TOKENS | Máximo de salida por llamada |
| LLM_TIMEOUT_MS | Por llamada: 120.000 ms local por defecto; 30.000 ms externo |

Los presupuestos reservan bytes UTF-8 de mensajes y esquemas, salida y margen por llamada; no equivalen a tokens facturados. Las cuotas siguen activas con el proveedor conectado. Si se alcanza un límite después de crear, la respuesta conserva el número de OC registrado.

El modelo utiliza pesos preentrenados de Qwen con licencia Apache 2.0. Nuestro trabajo es el agente de compras y la integración; no se entrenó un modelo desde cero. Fuentes: [modelo](https://ollama.com/library/qwen3:4b-instruct-2507-q4_K_M), [Ollama en Windows](https://docs.ollama.com/windows), [privacidad y modo local](https://docs.ollama.com/faq).

## Despliegue

Para un host Node ejecutar `npm ci` y `npm start`, configurar `HOST=0.0.0.0` y las variables secretas en el servicio. Usar una sola instancia con almacenamiento persistente para `out/`; el mock de archivos no es un backend distribuido. Mantener el servicio activo durante la defensa. Este repositorio no incluye una URL pública verificada todavía; una URL local no equivale a despliegue.

## Entrega

Incluir código, fixtures, lockfile, README y SOLUCION. Excluir `node_modules/`, `out/`, `.env`, `work/` y credenciales. Consultar SOLUCION.md para arquitectura, controles y plan de producción.
