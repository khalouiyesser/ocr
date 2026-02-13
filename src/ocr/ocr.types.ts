// ─── src/ocr/ocr.types.ts ────────────────────────────────────────────────────

export interface Address {
  nom: string | null;
  adresse: string | null;
  ville: string | null;
  code_postal: string | null;
  email: string | null;
  telephone: string | null;
  siret: string | null;
}

export interface Article {
  description: string;
  quantite: number | null;
  unite: string | null;
  prix_unitaire_ht: number | null;
  tva_pct: number | null;
  total_ht: number | null;
  total_tva: number | null;
  total_ttc: number | null;
  _validated?: boolean;
  _ocr_warning?: string;
}

export interface InvoiceResult {
  vendeur: Address | null;
  client: Address | null;
  date_facturation: string | null;
  date_echeance: string | null;
  numero_facture: string | null;
  conditions_paiement: string | null;
  reference_commande: string | null;
  informations_additionnelles: string | null;
  articles: Article[];
  totaux: {
    total_ht: number | null;
    total_tva: number | null;
    total_ttc: number | null;
  };
  meta: {
    confidence: number;
    rawText: string;
    warnings: string[];
  };
}
