// Adapter for the local OpenAI-compatible llama.cpp server.
export async function llamaCppChat(c, body, signal) {
  const combined = AbortSignal.any([signal, AbortSignal.timeout(c.requestMs)]);
  const response = await fetch(c.llamacpp + '/v1/chat/completions', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({...body, stream: false}), signal: combined,
  });
  if (!response.ok) throw Error(`llama.cpp HTTP ${response.status}`);
  const text = await response.text();
  if (text.length > 200000) throw Error('Model response too large');
  const data = JSON.parse(text), choice = data.choices?.[0];
  if (!choice?.message) throw Error('llama.cpp response has no message');
  return {message: choice.message, done_reason: choice.finish_reason ?? null,
    prompt_eval_count: data.usage?.prompt_tokens ?? null, eval_count: data.usage?.completion_tokens ?? null};
}
