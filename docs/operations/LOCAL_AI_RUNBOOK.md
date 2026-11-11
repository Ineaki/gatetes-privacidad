# Runbook local

Configuración privada del vault (`settings.json`):

```json
{"llamacpp":"http://127.0.0.1:8080","llamacppModel":"qwen3-30b-a3b","context":8192}
```

Arranca llama.cpp con un binario CUDA oficial y un GGUF explícito, por ejemplo `llama-server.exe -m <modelo.gguf> --host 127.0.0.1 --port 8080 -c 8192 -ngl 99`. Ajusta `-ngl` tras comprobar VRAM; no copies blobs internos de Ollama. Comprueba `http://127.0.0.1:8080/health` y `.../v1/models`. Para volver a Ollama elimina/omite `engine: "llamacpp"` y conserva el servidor Ollama.

Antes de operar: `nvidia-smi`, `ollama list`, `npm run doctor`. No se deben arrancar dos workers: el lock global lo impide. El rollback de código es retirar esta rama; el rollback de runtime es detener llama-server y quitar las claves `llamacpp*` del vault.
