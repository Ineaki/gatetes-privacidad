# Routing

El mensaje remoto usa `task.engine`. `llamacpp` solo puede activarse explícitamente y queda limitado a perfiles locales `checker`/`reviewer`; `implementer` mantiene la ruta Claude/Codex existente. Sin motor, se conserva el comportamiento previo. El modelo llama.cpp se configura con `llamacppModel` y, opcionalmente, `llamacppModels` por perfil.

No hay fallback automático a un proveedor de pago. La configuración exige URL HTTP loopback para Ollama y llama.cpp; no se permite escucha pública desde el runtime.
