# Puente GrokBot

`remote.mjs` valida mensajes del inbox, `server.mjs` atiende el gateway, `campaign.mjs` sincroniza el vault y `worker.mjs` ejecuta una tarea a la vez. `guard.mjs` aplica bloqueo y límites; `context.mjs` recorta memoria e historial a grupos completos. No hay polling de LLM en reposo: el bucle idle consulta SQLite.

Rutas actuales: `ollama` (local por defecto), `llamacpp` (local OpenAI-compatible explícito), `claude` y `codex` mediante `orq.mjs`. El fallback entre proveedores no es silencioso: un motor solicitado no disponible bloquea la tarea con motivo. Fox conserva el máximo de un reintento de escalado en orq y no recibe secretos ni evidencias completas.

La compatibilidad llama.cpp se limita a `/v1/chat/completions`, respuesta no streaming, herramientas en formato OpenAI y `temperature: 0`; sus respuestas se normalizan al formato interno Ollama. No se presupone que todos los modelos soporten tool calling.
