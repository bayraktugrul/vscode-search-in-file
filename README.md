# JetBrains Find in Files for VS Code

VS Code için JetBrains IDE'lerdeki "Find in Files" özelliğini taklit eden extension.

## Özellikler

- 🔍 Dosyalar içinde hızlı text arama
- ⚡ Shift+F kısayolu ile instant açılım
- 📝 Bulunan sonuçları context ile birlikte gösterim
- 🎯 Doğrudan sonuç satırına atlama
- 🚀 Performanslı arama algoritması

## Kullanım

1. **Shift+F** tuşlarına basın
2. Aranacak metni yazın (en az 2 karakter)
3. Sonuçlardan birine tıklayın
4. Dosya açılır ve bulunan metin seçili halde gösterilir

## Kurulum

### Development (Geliştirme)

```bash
# Bağımlılıkları yükle
npm install

# Kodu compile et
npm run compile

# VS Code'da F5'e basarak debug modunda çalıştır
```

### Extension Olarak Paketleme

```bash
# vsce paketleyicisini global olarak yükle
npm install -g vsce

# Extension paketini oluştur
vsce package

# Oluşan .vsix dosyasını VS Code'a yükle
```

## Teknik Detaylar

- **Dil:** TypeScript
- **VS Code API Version:** ^1.74.0
- **Arama Kapsamı:** Workspace içindeki tüm dosyalar (node_modules hariç)
- **Desteklenen Dosya Tipleri:** Tüm text dosyaları

## Katkıda Bulunma

1. Repository'yi fork edin
2. Feature branch oluşturun
3. Değişikliklerinizi commit edin
4. Pull request gönderin

## Lisans

MIT License 