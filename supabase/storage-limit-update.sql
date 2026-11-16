-- Bucket seviyesindeki özel dosya boyutu sınırını kaldır.
-- Supabase planındaki global dosya boyutu limiti yine geçerlidir.
-- Free plan için global sınır en fazla 50 MB/dosyadır; daha yüksek limit plan yükseltmesi gerektirir.
update storage.buckets
set file_size_limit = null
where id = 'da-question-images';

select id, file_size_limit
from storage.buckets
where id = 'da-question-images';
