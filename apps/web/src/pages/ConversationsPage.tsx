import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../lib/apiClient';
import { Icon } from '../components/Icon';

interface ChatMessage {
  id: string;
  role: string;
  content: string;
  mediaUrls: string[];
  createdAt: string;
}

interface Conversation {
  id: string;
  externalId: string;
  channel: string;
  state: string;
  lead: { name: string | null; phone: string | null; status: string } | null;
  messages: ChatMessage[];
  slots: Array<{ key: string; value: string }>;
  updatedAt: string;
}

const CHANNEL_STYLES: Record<string, string> = {
  whatsapp: 'bg-green-50 text-green-700',
  telegram: 'bg-blue-50 text-blue-700',
  web: 'bg-violet-50 text-violet-700',
  sms: 'bg-sky-50 text-sky-700',
  email: 'bg-amber-50 text-amber-700',
};

const STATE_LABELS: Record<string, string> = {
  greeting: 'Saludo',
  collecting_budget: 'Pidiendo presupuesto',
  collecting_movein: 'Pidiendo fecha',
  proposing_units: 'Proposando unidades',
  proposing_tour: 'Ofreciendo visita',
  scheduling: 'Agendando',
  handoff: 'Pasar a humano',
};

export function ConversationsPage() {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reply, setReply] = useState('');

  const { data, isLoading } = useQuery<{ conversations: Conversation[] }>({
    queryKey: ['conversations'],
    queryFn: () => apiFetch('/chat/conversations'),
  });

  const { data: detail } = useQuery<{ conversation: Conversation }>({
    queryKey: ['conversation', selectedId],
    queryFn: () => apiFetch(`/chat/conversations/${selectedId}`),
    enabled: !!selectedId,
  });

  const replyMutation = useMutation({
    mutationFn: ({ id, message }: { id: string; message: string }) =>
      apiFetch<{ status: string; message: { id: string; role: string; content: string; createdAt: string } }>(
        `/chat/conversations/${id}/reply`,
        {
          method: 'POST',
          body: JSON.stringify({ message }),
        },
      ),
    onSuccess: (data) => {
      // Añade el mensaje del staff inmediatamente a la conversación visible.
      queryClient.setQueryData<{ conversation: Conversation }>(
        ['conversation', selectedId],
        (old) => {
          if (!old) return old;
          return {
            conversation: {
              ...old.conversation,
              messages: [
                ...old.conversation.messages,
                {
                  id: data.message.id,
                  role: data.message.role,
                  content: data.message.content,
                  mediaUrls: [],
                  createdAt: data.message.createdAt,
                },
              ],
            },
          };
        },
      );
      queryClient.invalidateQueries({ queryKey: ['conversations'] });
      setReply('');
    },
  });

  const conversations = data?.conversations ?? [];
  const selected = detail?.conversation;

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Conversaciones</h1>
        <p className="text-sm text-slate-500">
          Historial de chats del bot con prospectos. Puedes intervenir manualmente cuando sea necesario.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Lista de conversaciones */}
        <div className="lg:col-span-1 bg-white rounded-lg border border-slate-200 overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200 bg-slate-50">
            <h2 className="font-medium text-sm">{conversations.length} conversaciones</h2>
          </div>
          <div className="divide-y divide-slate-100 max-h-[600px] overflow-y-auto">
            {isLoading && <p className="p-4 text-sm text-slate-400">Cargando...</p>}
            {conversations.length === 0 && (
              <p className="p-4 text-sm text-slate-400">Sin conversaciones aún.</p>
            )}
            {conversations.map((c) => (
              <button
                key={c.id}
                onClick={() => setSelectedId(c.id)}
                className={`w-full text-left p-3 hover:bg-slate-50 ${selectedId === c.id ? 'bg-violet-50' : ''}`}
              >
                <div className="flex items-center justify-between mb-1">
                  <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${CHANNEL_STYLES[c.channel] ?? 'bg-slate-100'}`}>
                    {c.channel}
                  </span>
                  <span className="text-xs text-slate-400">
                    {new Date(c.updatedAt).toLocaleDateString('en-CA')}
                  </span>
                </div>
                <div className="text-sm font-medium">
                  {c.lead?.name ?? c.lead?.phone ?? c.externalId}
                </div>
                <div className="text-xs text-slate-400">
                  {STATE_LABELS[c.state] ?? c.state}
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Detalle de conversación */}
        <div className="lg:col-span-2 bg-white rounded-lg border border-slate-200 overflow-hidden flex flex-col" style={{ minHeight: '600px' }}>
          {!selected ? (
            <div className="flex-1 flex items-center justify-center text-slate-400">
              Selecciona una conversación para ver el historial
            </div>
          ) : (
            <>
              {/* Header */}
              <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
                <div>
                  <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${CHANNEL_STYLES[selected.channel] ?? 'bg-slate-100'}`}>
                    {selected.channel}
                  </span>
                  <span className="ml-2 text-sm font-medium">
                    {selected.lead?.name ?? selected.externalId}
                  </span>
                </div>
                <span className="text-xs text-slate-400">{STATE_LABELS[selected.state] ?? selected.state}</span>
              </div>

              {/* Slots recolectados (solo los legibles, no los técnicos) */}
              {selected.slots.filter((s) => !s.key.startsWith('pending_') && !s.key.startsWith('scheduling_')).length > 0 && (
                <div className="px-4 py-2 border-b border-slate-100 bg-slate-50 flex flex-wrap gap-2">
                  {selected.slots
                    .filter((s) => !s.key.startsWith('pending_') && !s.key.startsWith('scheduling_'))
                    .map((s) => {
                      const labels: Record<string, string> = {
                        budget: 'Budget',
                        move_in_date: 'Move-in',
                        occupants: 'Occupants',
                        pets: 'Pets',
                        preferred_area: 'Area',
                      };
                      return (
                        <span key={s.key} className="text-xs bg-white border border-slate-200 rounded px-2 py-0.5">
                          <strong className="text-slate-500">{labels[s.key] ?? s.key}:</strong> {s.value}
                        </span>
                      );
                    })}
                </div>
              )}

              {/* Mensajes */}
              <div className="flex-1 overflow-y-auto p-4 space-y-2 max-h-[400px]">
                {selected.messages.map((msg) => (
                  <div
                    key={msg.id}
                    className={`flex ${
                      msg.role === 'user' ? 'justify-start' : 'justify-end'
                    }`}
                  >
                    <div
                      className={`max-w-[75%] rounded-2xl px-3 py-2 text-sm ${
                        msg.role === 'user'
                          ? 'bg-slate-100 text-slate-700 rounded-bl-md'
                          : msg.role === 'staff'
                            ? 'bg-blue-600 text-white rounded-br-md'
                            : 'bg-violet-600 text-white rounded-br-md'
                      }`}
                    >
                      {msg.role === 'staff' && (
                        <div className="text-[10px] opacity-75 mb-0.5">👤 Staff</div>
                      )}
                      {msg.role === 'assistant' && (
                        <div className="text-[10px] opacity-75 mb-0.5">🤖 Bot</div>
                      )}
                      {msg.content}
                    </div>
                  </div>
                ))}
              </div>

              {/* Reply manual */}
              <div className="p-3 border-t border-slate-200 flex gap-2">
                <input
                  type="text"
                  value={reply}
                  onChange={(e) => setReply(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && reply.trim()) {
                      replyMutation.mutate({ id: selected.id, message: reply.trim() });
                    }
                  }}
                  placeholder="Intervenir manualmente..."
                  className="flex-1 rounded-full border border-slate-300 px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500"
                />
                <button
                  onClick={() => reply.trim() && replyMutation.mutate({ id: selected.id, message: reply.trim() })}
                  disabled={!reply.trim() || replyMutation.isPending}
                  className="inline-flex items-center gap-1 rounded-full bg-violet-600 px-4 py-2 text-white text-sm hover:bg-violet-700 disabled:opacity-50"
                >
                  <Icon name="upload" size={14} className="rotate-90" />
                  Enviar
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
