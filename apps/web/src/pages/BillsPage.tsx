import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../lib/apiClient';
import type { Bill } from '../lib/types';
import { Icon } from '../components/Icon';

const STATUS_STYLES: Record<string, string> = {
  pending_ocr: 'bg-amber-100 text-amber-800',
  pending_review: 'bg-orange-100 text-orange-800',
  approved: 'bg-blue-100 text-blue-800',
  synced_to_qbo: 'bg-green-100 text-green-800',
  rejected: 'bg-red-100 text-red-800',
};

const STATUS_LABELS: Record<string, string> = {
  pending_ocr: 'OCR pending',
  pending_review: 'Human review',
  approved: 'Approved',
  synced_to_qbo: 'Synced to QBO',
  rejected: 'Rejected',
};

function formatMoney(cents: number, currency: string): string {
  return new Intl.NumberFormat('en-CA', { style: 'currency', currency }).format(cents / 100);
}

export function BillsPage() {
  const queryClient = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [filter, setFilter] = useState<string>('');

  const { data, isLoading } = useQuery<{ bills: Bill[] }>({
    queryKey: ['bills', filter],
    queryFn: () => apiFetch(`/bills${filter ? `?status=${filter}` : ''}`),
  });

  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const base64 = await fileToBase64(file);
      return apiFetch<{ bill: Bill }>('/bills/process-receipt', {
        method: 'POST',
        body: JSON.stringify({
          mimeType: file.type || 'application/pdf',
          base64,
          filename: file.name,
        }),
      });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['bills'] }),
  });

  const approveMutation = useMutation({
    mutationFn: (id: string) => apiFetch(`/bills/${id}/approve`, { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['bills'] }),
  });

  const rejectMutation = useMutation({
    mutationFn: (id: string) => apiFetch(`/bills/${id}/reject`, { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['bills'] }),
  });

  const bills = data?.bills ?? [];

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Bills / OCR</h1>
          <p className="text-sm text-slate-500">
            Upload vendor receipts. The AI extracts the bill data and prepares QuickBooks sync.
          </p>
        </div>
        <button
          onClick={() => fileInput.current?.click()}
          disabled={uploadMutation.isPending}
          className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-white font-medium shadow-sm shadow-blue-600/20 hover:bg-blue-700 disabled:opacity-50"
        >
          <Icon name="upload" size={18} />
          {uploadMutation.isPending ? 'Processing...' : 'Upload receipt'}
        </button>
        <input
          ref={fileInput}
          type="file"
          accept=".pdf,image/*"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) uploadMutation.mutate(file);
            e.target.value = '';
          }}
        />
      </div>

      {uploadMutation.isError && (
        <div className="mb-4 rounded-md bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">
          Unable to process the receipt. Upload a valid PDF or image file.
        </div>
      )}
      {uploadMutation.isSuccess && (
        <div className="mb-4 rounded-md bg-green-50 border border-green-200 px-3 py-2 text-sm text-green-700">
          Receipt processed: {uploadMutation.data.bill.vendorName} - {formatMoney(uploadMutation.data.bill.totalCents, 'CAD')} ({STATUS_LABELS[uploadMutation.data.bill.status] ?? uploadMutation.data.bill.status})
        </div>
      )}

      <div className="mb-4 flex gap-2 text-sm">
        {['', 'pending_review', 'synced_to_qbo', 'rejected'].map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`rounded-full px-3 py-1 ${
              filter === f ? 'bg-slate-900 text-white' : 'bg-white border border-slate-200 text-slate-600'
            }`}
          >
            {f === '' ? 'All bills' : STATUS_LABELS[f] ?? f}
          </button>
        ))}
      </div>

      <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-600 text-xs uppercase">
            <tr>
              <th className="text-left px-4 py-3 font-medium">Vendor</th>
              <th className="text-left px-4 py-3 font-medium">Date</th>
              <th className="text-right px-4 py-3 font-medium">Amount</th>
              <th className="text-left px-4 py-3 font-medium">Category</th>
              <th className="text-center px-4 py-3 font-medium">OCR confidence</th>
              <th className="text-center px-4 py-3 font-medium">Status</th>
              <th className="text-center px-4 py-3 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {isLoading && (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-slate-400">Loading bills...</td></tr>
            )}
            {!isLoading && bills.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-slate-400">
                  No bills match this filter. Upload a receipt or switch filters to continue the demo.
                </td>
              </tr>
            )}
            {bills.map((bill) => (
              <tr key={bill.id} className="hover:bg-slate-50">
                <td className="px-4 py-3 font-medium">{bill.vendorName}</td>
                <td className="px-4 py-3 text-slate-600">{new Date(bill.billDate).toLocaleDateString('en-CA')}</td>
                <td className="px-4 py-3 text-right font-mono">{formatMoney(bill.totalCents, bill.currency)}</td>
                <td className="px-4 py-3 text-slate-600">{bill.category}</td>
                <td className="px-4 py-3 text-center">
                  {bill.ocrConfidence !== null && (
                    <span className={bill.ocrConfidence > 0.85 ? 'text-green-600' : 'text-orange-600'}>
                      {(bill.ocrConfidence * 100).toFixed(0)}%
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 text-center">
                  <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${STATUS_STYLES[bill.status] ?? 'bg-slate-100'}`}>
                    {STATUS_LABELS[bill.status] ?? bill.status}
                  </span>
                </td>
                <td className="px-4 py-3 text-center">
                  {bill.status === 'pending_review' && (
                    <div className="flex gap-1.5 justify-center">
                      <button
                        onClick={() => approveMutation.mutate(bill.id)}
                        disabled={approveMutation.isPending}
                        className="inline-flex items-center gap-1 rounded-md bg-green-50 px-2 py-1 text-xs font-medium text-green-700 hover:bg-green-100"
                      >
                        <Icon name="approve" size={14} />
                        Approve
                      </button>
                      <button
                        onClick={() => rejectMutation.mutate(bill.id)}
                        disabled={rejectMutation.isPending}
                        className="inline-flex items-center gap-1 rounded-md bg-red-50 px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-100"
                      >
                        <Icon name="reject" size={14} />
                        Reject
                      </button>
                    </div>
                  )}
                  {bill.qboBillId && (
                    <span className="inline-flex items-center gap-1 rounded-md bg-cyan-50 px-1.5 py-0.5 text-xs font-medium text-cyan-700" title={`QBO: ${bill.qboBillId}`}>
                      <Icon name="qbo" size={12} />
                      QBO
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const base64 = result.split(',')[1] ?? '';
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
