# Ollama vs llama.cpp

No se declara una mejora de rendimiento: se instaló el binario oficial aislado `b12131`, versión `0.9.0-dev`, pero no había GGUF reutilizable de forma segura ni endpoint `127.0.0.1:8080`, por lo que no se arrancó un servidor ni se ejecutó un benchmark. SHA-256 del ZIP descargado: `85DE243E6E1074280BE49DB84E51E9FF1A655B05ACB0AA33B47AE37216D77000`; del ejecutable: `D5A6F2C47C26AA144928266466EE49C4737262AF2C779A71D1D6F6D52603DD82`. El baseline aportado por el operador (47 tok/s coder 7B, 55 tok/s VL 7B, 7–12 tok/s coder 14B, 32–37 tok/s Qwen3 30B-A3B) queda registrado como referencia no equivalente.

La comparación pendiente debe fijar el mismo GGUF/cuanti­zación, prompt, contexto 8192, temperatura, `-ngl`, petición y estado frío/caliente; registrar tres ejecuciones medianas de TTFT, tok/s, latencia y memoria. Los resultados deben conservarse fuera de Git junto con versión del binario y checksum.
