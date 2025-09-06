const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const multer = require('multer');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Supabase client with your credentials
const supabase = createClient(
  process.env.SUPABASE_URL || 'https://uqyihdratmmprqavxmrl.supabase.co',
  process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVxeWloZHJhdG1tcHJxYXZ4bXJsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTQyMzQyOTQsImV4cCI6MjA2OTgxMDI5NH0.H1MmPWGrZGnjEYPbYECs1l-okx3jvQZWd81HYaLhLgI'
);

// Enhanced CORS configuration
app.use(cors({
  origin: function(origin, callback) {
    // Allow requests with no origin (mobile apps, curl, etc.)
    if (!origin) return callback(null, true);
    
    const allowedOrigins = [
      'https://ggg1234555.github.io',
      'http://localhost:8080',
      'http://localhost:8000',
      'http://localhost:3000',
      'http://127.0.0.1:8080',
      'http://127.0.0.1:8000',
      'http://127.0.0.1:3000'
    ];
    
    if (allowedOrigins.includes(origin) || origin.includes('localhost') || origin.includes('127.0.0.1')) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'HEAD'],
  allowedHeaders: [
    'Origin',
    'X-Requested-With',
    'Content-Type',
    'Accept',
    'Authorization',
    'Cache-Control',
    'X-HTTP-Method-Override'
  ],
  credentials: true,
  optionsSuccessStatus: 200 // For legacy browser support
}));

// Add these middleware in the correct order
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Add request logging for debugging
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path} from ${req.get('origin') || req.get('host')}`);
  next();
});

// Multer for file uploads
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { 
    fileSize: 5 * 1024 * 1024, // 5MB limit
    files: 5 // Max 5 files
  },
  fileFilter: (req, file, cb) => {
    // Accept only image files
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed!'), false);
    }
  }
});

// Handle preflight requests explicitly
app.options('*', cors());

// Root endpoint
app.get('/', (req, res) => {
  res.json({ 
    message: 'Car Search API is running',
    endpoints: ['/api/search', '/api/submit', '/health'],
    timestamp: new Date().toISOString()
  });
});

// Search endpoint with improved error handling
app.post('/api/search', async (req, res) => {
  try {
    console.log('Search request body:', req.body);
    const { query } = req.body;
    
    if (!query || query.trim().length === 0) {
      return res.status(400).json({ 
        error: 'Невалиден VIN/рег. №',
        details: 'Query parameter is required'
      });
    }

    const cleanQuery = query.trim().toUpperCase();

    // First check local database
    let localResult = await supabase
      .from('cars')
      .select('*')
      .or(`plate.eq.${cleanQuery},vin.eq.${cleanQuery}`)
      .single();

    if (localResult.data) {
      return res.json({
        source: 'local',
        data: {
          make: localResult.data.make,
          model: localResult.data.model,
          year: localResult.data.year,
          hp: localResult.data.hp,
          mileage: localResult.data.mileage,
          notes: localResult.data.notes,
          photos: localResult.data.photos || [],
          plate: localResult.data.plate,
          vin: localResult.data.vin
        }
      });
    }

    // If not found locally and query is 17 chars (VIN), try NHTSA
    if (cleanQuery.length === 17) {
      try {
        console.log('Trying NHTSA API for VIN:', cleanQuery);
        const nhtsa_response = await axios.get(
          `https://vpic.nhtsa.dot.gov/api/vehicles/decodevin/${cleanQuery}?format=json`,
          { timeout: 10000 } // 10 second timeout
        );

        if (nhtsa_response.data && nhtsa_response.data.Results) {
          const results = nhtsa_response.data.Results;
          
          // Extract relevant data from NHTSA response
          const findValue = (field) => {
            const item = results.find(r => r.Variable === field);
            return item && item.Value && item.Value !== 'Not Applicable' ? item.Value : null;
          };

          const data = {
            make: findValue('Make'),
            model: findValue('Model'),
            year: findValue('Model Year'),
            bodyClass: findValue('Body Class'),
            fuelType: findValue('Fuel Type - Primary'),
            engineHP: findValue('Engine Power (kW)'),
            vin: cleanQuery
          };

          // Convert kW to HP if available
          if (data.engineHP) {
            data.hp = Math.round(parseFloat(data.engineHP) * 1.341);
          }

          return res.json({
            source: 'nhtsa',
            data: data
          });
        }
      } catch (error) {
        console.error('NHTSA API error:', error.message);
        // Don't return error immediately, fall through to 404
      }
    }

    // No results found
    res.status(404).json({ 
      error: 'Не са намерени данни за този автомобил',
      query: cleanQuery
    });

  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ 
      error: 'Грешка при търсенето',
      details: error.message
    });
  }
});

// Submit car endpoint with improved error handling
app.post('/api/submit', upload.array('photos', 5), async (req, res) => {
  try {
    console.log('Submit request body:', req.body);
    console.log('Files received:', req.files ? req.files.length : 0);
    
    const { plate, vin, hp, mileage, year, make, model, notes, consent } = req.body;

    // Validate consent
    if (consent !== 'true') {
      return res.status(400).json({ 
        error: 'Моля, потвърдете съгласието си',
        field: 'consent'
      });
    }

    // Validate required fields
    if (!plate && !vin) {
      return res.status(400).json({ 
        error: 'Моля, въведете рег. № или VIN',
        field: 'plate_or_vin'
      });
    }

    let photoUrls = [];

    // Upload photos if provided
    if (req.files && req.files.length > 0) {
      console.log(`Uploading ${req.files.length} photos...`);
      
      for (const file of req.files) {
        try {
          const fileName = `${Date.now()}-${Math.random().toString(36).substring(7)}-${file.originalname}`;
          const filePath = `car-photos/${fileName}`;

          const { data: uploadData, error: uploadError } = await supabase.storage
            .from('photos')
            .upload(filePath, file.buffer, {
              contentType: file.mimetype,
              cacheControl: '3600'
            });

          if (uploadError) {
            console.error('Photo upload error:', uploadError);
            continue;
          }

          // Get public URL
          const { data: urlData } = supabase.storage
            .from('photos')
            .getPublicUrl(filePath);

          if (urlData) {
            photoUrls.push(urlData.publicUrl);
          }
        } catch (photoError) {
          console.error('Individual photo error:', photoError);
          // Continue with other photos
        }
      }
    }

    // Insert car record
    const carRecord = {
      plate: plate ? plate.trim().toUpperCase() : null,
      vin: vin ? vin.trim().toUpperCase() : null,
      hp: hp ? parseInt(hp) : null,
      mileage: mileage ? parseInt(mileage) : null,
      year: year ? parseInt(year) : null,
      make: make ? make.trim() : null,
      model: model ? model.trim() : null,
      notes: notes ? notes.trim() : null,
      photos: photoUrls.length > 0 ? photoUrls : null,
      created_at: new Date().toISOString()
    };

    console.log('Inserting car record:', carRecord);

    const { data: carData, error: carError } = await supabase
      .from('cars')
      .insert(carRecord)
      .select()
      .single();

    if (carError) {
      console.error('Database insert error:', carError);
      return res.status(500).json({ 
        error: 'Грешка при записването в базата данни',
        details: carError.message
      });
    }

    res.json({ 
      success: true, 
      message: 'Автомобилът е добавен успешно',
      id: carData.id,
      photosUploaded: photoUrls.length
    });

  } catch (error) {
    console.error('Submit error:', error);
    
    // Handle multer errors
    if (error instanceof multer.MulterError) {
      if (error.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ 
          error: 'Файлът е твърде голям (максимум 5MB)',
          field: 'photos'
        });
      }
      if (error.code === 'LIMIT_FILE_COUNT') {
        return res.status(400).json({ 
          error: 'Твърде много файлове (максимум 5)',
          field: 'photos'
        });
      }
    }
    
    if (error.message === 'Only image files are allowed!') {
      return res.status(400).json({ 
        error: 'Разрешени са само изображения',
        field: 'photos'
      });
    }

    res.status(500).json({ 
      error: 'Грешка при добавянето на автомобила',
      details: error.message
    });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    port: PORT,
    env: process.env.NODE_ENV || 'development'
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    error: 'Endpoint not found',
    path: req.originalUrl,
    method: req.method
  });
});

// Global error handler
app.use((error, req, res, next) => {
  console.error('Global error handler:', error);
  
  if (error.message === 'Not allowed by CORS') {
    return res.status(403).json({
      error: 'CORS error - origin not allowed',
      origin: req.get('origin')
    });
  }
  
  res.status(500).json({
    error: 'Internal server error',
    details: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong'
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Allowed origins: https://ggg1234555.github.io, localhost variations`);
});