import { useState, useRef, useEffect } from 'react';
import { apiFetch } from '../lib/apiClient';
import { Icon } from './Icon';

interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

/**
 * Widget de chat embebido para la página pública de una unidad.
 *
 * El visitante conversa con el chatbot IA sin necesidad de login.
 * Se identifica por tenantId (header) y sessionId (localStorage).
 */
export function ChatWidget({ tenantId, unitName }: { tenantId: string; unitName?: string }) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: 'assistant',
      content: unitName
        ? `¡Hola! 👋 Soy el asistente virtual. ¿Te interesa ${unitName}? Puedo ayudarte a agendar una visita.`
        : '¡Hola! Soy el asistente virtual. ¿En qué puedo ayudarte?',
    },
  ]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [sessionId] = useState(() => {
    let id = localStorage.getItem('pm_chat_session');
    if (!id) {
      id = `s_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      localStorage.setItem('pm_chat_session', id);
    }
    return id;
  });
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  async function sendMessage() {
    if (!input.trim() || loading) return;
    const userMsg: ChatMessage = { role: 'user', content: input.trim() };
    setMessages((m) => [...m, userMsg]);
    setInput('');
    setLoading(true);

    try {
      const result = await apiFetch<{ replyText: string }>(
        '/chat/messages',
        {
          method: 'POST',
          body: JSON.stringify({ sessionId, message: userMsg.content }),
        },
        tenantId,
      );
      setMessages((m) => [...m, { role: 'assistant', content: result.replyText }]);
    } catch {
      setMessages((m) => [
        ...m,
        { role: 'assistant', content: 'Disculpa, hubo un error. Intenta de nuevo.' },
      ]);
    } finally {
      setLoading(false);
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-6 right-6 z-50 inline-flex items-center gap-2 rounded-full bg-violet-600 px-5 py-3 text-white font-medium shadow-lg shadow-violet-600/30 hover:bg-violet-700"
      >
        <Icon name="chat" size={20} />
        Chatea con nosotros
      </button>
    );
  }

  return (
    <div className="fixed bottom-6 right-6 z-50 w-96 max-w-[calc(100vw-2rem)] bg-white rounded-2xl shadow-xl border border-slate-200 flex flex-col" style={{ height: '500px', maxHeight: 'calc(100vh-3rem)' }}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 bg-violet-600 rounded-t-2xl">
        <div className="flex items-center gap-2 text-white">
          <Icon name="chat" size={18} />
          <span className="font-medium text-sm">Asistente virtual</span>
        </div>
        <button onClick={() => setOpen(false)} className="text-white/80 hover:text-white">
          ✕
        </button>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3 bg-slate-50">
        {messages.map((msg, i) => (
          <div
            key={i}
            className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
          >
            <div
              className={`max-w-[80%] rounded-2xl px-3 py-2 text-sm ${
                msg.role === 'user'
                  ? 'bg-violet-600 text-white rounded-br-md'
                  : 'bg-white text-slate-700 border border-slate-200 rounded-bl-md'
              }`}
            >
              {msg.content}
            </div>
          </div>
        ))}
        {loading && (
          <div className="flex justify-start">
            <div className="bg-white border border-slate-200 rounded-2xl rounded-bl-md px-3 py-2 text-sm text-slate-400">
              escribiendo...
            </div>
          </div>
        )}
      </div>

      {/* Input */}
      <div className="p-3 border-t border-slate-200 flex gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && sendMessage()}
          placeholder="Escribe tu mensaje..."
          className="flex-1 rounded-full border border-slate-300 px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500"
          disabled={loading}
        />
        <button
          onClick={sendMessage}
          disabled={loading || !input.trim()}
          className="inline-flex items-center justify-center rounded-full bg-violet-600 px-4 py-2 text-white hover:bg-violet-700 disabled:opacity-50"
        >
          <Icon name="upload" size={16} className="rotate-90" />
        </button>
      </div>
    </div>
  );
}
